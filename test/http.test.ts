import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { format } from 'node:util';
import { Client, StreamableHTTPClientTransport, type ClientOptions } from '@modelcontextprotocol/client';
import { openDb } from '../src/db.ts';
import { MAX_BODY_BYTES, isLoopbackAddress, serveHttp, type HttpServing } from '../src/http.ts';
import { createServer } from '../src/server.ts';
import { FIXTURE } from './harness.ts';

/**
 * src/http.ts in process: protocol, routes, guards, the body cap and log privacy, over real HTTP on
 * 127.0.0.1 with an ephemeral port and the fixture index. Hand-built requests go through node:http's
 * client on a connection of their own, because a fetch can neither send a foreign Host nor declare a body
 * it never sends.
 */

const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';

/** The per-request envelope a negotiating client 2.0.0 puts in `params._meta`. */
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'http-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** A legacy-era tools/list, which needs no handshake on a stateless server. */
const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

const handle = openDb(FIXTURE);
const logged: string[] = [];
let serving: HttpServing;

before(async () => {
  serving = await serveHttp(() => createServer(handle), { host: '127.0.0.1', port: 0, log: (line) => logged.push(line) });
});

after(async () => {
  await serving.close();
  handle.close();
});

// No request to the shared server is answered 500 or above, so nothing it answers is logged: not a
// listener answer, not a guard's 403, and not a client error from the handler.
afterEach(() => {
  assert.deepEqual(logged.splice(0), [], 'the server logged an answer below 500');
});

type Answer = { status: number; headers: IncomingHttpHeaders; body: string };

type Outgoing = {
  method: string;
  path?: string;
  headers: Record<string, string>;
  /** Sent after the headers. Without it only the headers go out, whatever length they declare. */
  body?: string;
  url?: URL;
  /** How long the whole answer may take. */
  timeoutMs?: number;
};

/** One hand-built request on its own connection, resolved with the complete answer. */
function send({ method, path = '/mcp', headers, body, url = serving.url, timeoutMs = 10_000 }: Outgoing): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        // A URL brackets an IPv6 hostname, and a connection takes the bare address.
        host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        port: url.port,
        method,
        path,
        headers,
        agent: false,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (incoming) => {
        let text = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => {
          text += chunk;
        });
        incoming.on('end', () => {
          resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: text });
          outgoing.destroy();
        });
      },
    );
    outgoing.on('error', reject);
    if (body === undefined) outgoing.flushHeaders();
    else outgoing.end(body);
  });
}

/** The headers every request that reaches the MCP handler sends, for its protocol era. */
function mcpHeaders(era: string, url = serving.url): Record<string, string> {
  return {
    host: url.host,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': era,
  };
}

/** A POST carrying `body` with its length. */
function post(body: string, headers: Record<string, string>, url = serving.url, path = '/mcp'): Promise<Answer> {
  return send({ method: 'POST', url, path, headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, body });
}

/** The JSON-RPC messages of an SSE body, one per event. Legacy-era answers come as SSE. */
function events(body: string): unknown[] {
  return body
    .split('\n\n')
    .map((event) => event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5)).join('\n'))
    .filter((data) => data.trim() !== '')
    .map((data) => JSON.parse(data));
}

/**
 * Connects client 2.0.0 with `options`, lists the tools and runs one known search, recording the
 * mcp-session-id header of every response the transport receives.
 */
async function exercise(options: ClientOptions) {
  const sessionIds: Array<string | null> = [];
  const client = new Client({ name: 'http-test', version: '1.0.0' }, options);
  await client.connect(
    new StreamableHTTPClientTransport(serving.url, {
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        sessionIds.push(response.headers.get('mcp-session-id'));
        return response;
      },
    }),
  );
  try {
    const { tools } = await client.listTools();
    const search = await client.callTool({ name: 'tibia_search', arguments: { query: 'dragon', limit: 1 } });
    return {
      version: client.getNegotiatedProtocolVersion(),
      tools: tools.length,
      isError: search.isError ?? false,
      first: (search.structuredContent as { results: Array<{ title: string }> }).results[0]?.title,
      listChanged: client.getServerCapabilities()?.tools?.listChanged,
      sessionIds,
    };
  } finally {
    await client.close();
  }
}

for (const [label, options, version] of [
  ['default options', {}, LEGACY],
  ["versionNegotiation: { mode: 'auto' }", { versionNegotiation: { mode: 'auto' } }, MODERN],
] as const) {
  test(`client 2.0.0 with ${label} negotiates ${version} and is served without a session`, async () => {
    const run = await exercise(options);
    assert.equal(run.version, version);
    assert.equal(run.tools, 5);
    assert.equal(run.isError, false);
    assert.equal(run.first, 'Dragon');
    assert.equal(run.listChanged, false);
    assert.ok(run.sessionIds.length > 0, 'the tracing fetch saw no response');
    assert.deepEqual(run.sessionIds.filter((id) => id !== null), [], 'a response carried mcp-session-id');
  });
}

test('a subscriptions/listen is refused in-band with -32603, before any stream opens', async () => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    method: 'subscriptions/listen',
    params: { notifications: { toolsListChanged: true }, _meta: ENVELOPE },
  });
  const answer = await post(body, { ...mcpHeaders(MODERN), 'mcp-method': 'subscriptions/listen' });
  assert.equal(answer.status, 200);
  assert.match(String(answer.headers['content-type']), /^application\/json/, 'the refusal opened a stream');
  assert.deepEqual(JSON.parse(answer.body), {
    jsonrpc: '2.0',
    error: { code: -32603, message: 'Subscription limit reached' },
    id: 7,
  });
});

test('GET /ping answers ok whatever its query, and any path but /mcp answers 404', async () => {
  const ping = await send({ method: 'GET', path: '/ping?from=health-check', headers: {} });
  assert.deepEqual([ping.status, ping.headers['content-type'], ping.body], [200, 'text/plain', 'ok']);
  for (const path of ['/nope', '/mcp/', '/']) {
    const unknown = await send({ method: 'GET', path, headers: mcpHeaders(LEGACY) });
    assert.deepEqual([unknown.status, unknown.headers['content-type'], unknown.body], [404, 'text/plain', 'not found'], path);
  }
});

test('GET /mcp reaches the handler, which answers 405 on a stateless server', async () => {
  const answer = await send({ method: 'GET', headers: mcpHeaders(LEGACY) });
  assert.equal(answer.status, 405);
  // The SDK's JSON-RPC answer, not the listener's text/plain one.
  assert.match(String(answer.headers['content-type']), /^application\/json/);
});

test('a POST to /mcp without Content-Length gets 411', async () => {
  const answer = await send({
    method: 'POST',
    headers: { ...mcpHeaders(LEGACY), 'transfer-encoding': 'chunked' },
    body: TOOLS_LIST,
  });
  assert.equal(answer.status, 411);
  assert.equal(answer.headers['content-type'], 'text/plain');
});

test('a POST declaring 65,537 bytes gets 413 before any of them is sent, and 65,536 bytes reach the handler', async () => {
  assert.equal(MAX_BODY_BYTES, 65_536);
  // No byte of the declared body is ever sent, so an answer shows the length alone decided it.
  const over = await send({ method: 'POST', headers: { ...mcpHeaders(LEGACY), 'content-length': '65537' }, timeoutMs: 1_000 });
  assert.equal(over.status, 413);
  assert.equal(over.headers['content-type'], 'text/plain');

  // JSON allows whitespace after the message, so padding makes a valid request of exactly the cap.
  const exact = await post(TOOLS_LIST.padEnd(65_536, ' '), mcpHeaders(LEGACY));
  assert.equal(exact.status, 200);
  const [message] = events(exact.body) as Array<{ result: { tools: unknown[] } }>;
  assert.equal(message?.result.tools.length, 5);
});

test('PUT and DELETE on /mcp get 405 with Allow: GET, POST before their bodies are read', async () => {
  for (const method of ['PUT', 'DELETE']) {
    // The declared 10 MiB never comes, so an answer within 1 s shows nothing waited to read it.
    const answer = await send({ method, headers: { ...mcpHeaders(LEGACY), 'content-length': '10485760' }, timeoutMs: 1_000 });
    assert.equal(answer.status, 405, method);
    assert.equal(answer.headers.allow, 'GET, POST', method);
    assert.equal(answer.headers['content-type'], 'text/plain', method);
  }
});

test('on a loopback bind a foreign Host or Origin gets 403, and the bound Host is served', async () => {
  const foreignHost = await post(TOOLS_LIST, { ...mcpHeaders(LEGACY), host: 'evil.example' });
  assert.equal(foreignHost.status, 403);
  const foreignOrigin = await post(TOOLS_LIST, { ...mcpHeaders(LEGACY), origin: 'https://evil.example' });
  assert.equal(foreignOrigin.status, 403);
  const own = await post(TOOLS_LIST, mcpHeaders(LEGACY));
  assert.equal(own.status, 200);
});

test('loopback is decided on the bound address, so a 127.1 bind keeps its guards and serves its own Host', async () => {
  // 127.1 is not a dotted quad, yet it binds 127.0.0.1: the given string would switch the guards off.
  const spelled = await serveHttp(() => createServer(handle), { host: '127.1', port: 0, log: (line) => logged.push(line) });
  try {
    assert.equal(spelled.url.hostname, '127.0.0.1');
    const foreign = await post(TOOLS_LIST, { ...mcpHeaders(LEGACY, spelled.url), host: 'evil.example' }, spelled.url);
    assert.equal(foreign.status, 403);
    const own = await post(TOOLS_LIST, { ...mcpHeaders(LEGACY, spelled.url), host: `127.1:${spelled.url.port}` }, spelled.url);
    assert.equal(own.status, 200);
  } finally {
    await spelled.close();
  }
});

test('an IPv4-mapped loopback bind keeps its guards and serves the Host its own url names', async () => {
  const mapped = await serveHttp(() => createServer(handle), {
    host: '::ffff:127.0.0.1',
    port: 0,
    log: (line) => logged.push(line),
  });
  try {
    // A URL writes the mapped address in hex, so a client using this url sends that form as its Host.
    assert.equal(mapped.url.hostname, '[::ffff:7f00:1]');
    const own = await post(TOOLS_LIST, mcpHeaders(LEGACY, mapped.url), mapped.url);
    assert.equal(own.status, 200);
    const foreign = await post(TOOLS_LIST, { ...mcpHeaders(LEGACY, mapped.url), host: 'evil.example' }, mapped.url);
    assert.equal(foreign.status, 403);
  } finally {
    await mapped.close();
  }
});

test('isLoopbackAddress classifies server.address() values', () => {
  for (const [address, loopback] of [
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['0.0.0.0', false],
    ['::', false],
    ['192.168.1.10', false],
    ['::ffff:192.168.1.10', false],
    ['128.0.0.1', false],
    // server.address() never reports a name.
    ['localhost', false],
  ] as const) {
    assert.equal(isLoopbackAddress(address), loopback, address);
  }
});

test('serveHttp rejects with the listen error when the port is taken', async () => {
  const holder = createHttpServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address() as AddressInfo;
  try {
    await assert.rejects(
      serveHttp(() => createServer(handle), { host: '127.0.0.1', port, log: (line) => logged.push(line) }),
      { code: 'EADDRINUSE' },
    );
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});

test('serveHttp refuses a grace that a timer cannot hold', async () => {
  // Node runs a timer over 2^31 - 1 ms after 1 ms, which would end the drain at once.
  for (const graceMs of [-1, Number.NaN, 2 ** 31]) {
    await assert.rejects(
      serveHttp(() => createServer(handle), { host: '127.0.0.1', port: 0, log: (line) => logged.push(line), graceMs }),
      RangeError,
      String(graceMs),
    );
  }
});

test('client values never reach the log or stderr, and a 500 logs only its status line', async () => {
  const marker = `MARKER-${randomUUID()}`;
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
  };
  const healthy = await serveHttp(() => createServer(handle), { host: '127.0.0.1', port: 0, log });
  const failing = await serveHttp(
    () => {
      throw new Error(marker);
    },
    { host: '127.0.0.1', port: 0, log },
  );
  /** A modern tools/call with `name` as its Mcp-Name, and the marker in its query string too. */
  const call = (url: URL, name: string, message: object) =>
    post(
      JSON.stringify(message),
      { ...mcpHeaders(MODERN, url), 'mcp-method': 'tools/call', 'mcp-name': name },
      url,
      `/mcp?note=${marker}`,
    );
  const named = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: marker, arguments: { note: marker }, _meta: ENVELOPE },
  };

  const written: string[] = [];
  const write = process.stderr.write;
  const error = console.error;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return Reflect.apply(write, process.stderr, [chunk, ...rest]) as boolean;
  }) as typeof process.stderr.write;
  console.error = (...args: unknown[]) => {
    written.push(format(...args));
    error(...args);
  };
  try {
    try {
      // JSON, but no JSON-RPC 2.0 message.
      assert.equal((await call(healthy.url, marker, { ...named, jsonrpc: '1.0' })).status, 400);
      // The SDK's rejection message quotes both names.
      assert.equal((await call(healthy.url, `${marker}-header`, named)).status, 400);
      // The factory's error message is the marker itself.
      assert.equal((await call(failing.url, marker, named)).status, 500);
    } finally {
      await Promise.all([healthy.close(), failing.close()]);
    }
  } finally {
    // Removed only after close(), so whatever the drain writes is observed too.
    process.stderr.write = write;
    console.error = error;
  }

  assert.equal(lines.filter((line) => line.includes(marker)).length, 0, 'a log line carries a client value');
  assert.equal(written.filter((text) => text.includes(marker)).length, 0, 'stderr carries a client value');
  assert.equal(lines.length, 1, `expected one status line, got ${lines.length}`);
  assert.match(lines[0] ?? '', /^tibiawiki-mcp: POST \/mcp answered 500 in \d+ ms$/);
});
