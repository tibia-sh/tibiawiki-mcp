import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { request } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDb } from '../src/db.ts';
import { MAX_BODY_BYTES } from '../src/http.ts';
import { TOOL_NAMES } from '../src/server.ts';
import { FIXTURE, tempDirs } from './harness.ts';

/**
 * `tibiawiki-mcp serve --http` as a user runs it: the built binary, spawned the way stdio.test.ts spawns it,
 * on an ephemeral port. This covers the flags, the startup line, the startup failures and the signals. What
 * the transport answers and how it drains is covered in process, by http.test.ts and http-drain.test.ts.
 */

const USAGE = 'Usage: tibiawiki-mcp [serve [--http [--host <address>] [--port <number>]]|build-index|index-digest <path>]';

/** The startup line, with the port the server bound. Other lines, such as the SDK's own warning, may come first. */
const STARTUP = /^tibiawiki-mcp listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp, index generated \S+ by tibiawiki-sql \S+$/m;

const scratch = tempDirs('twmcp-serve-http-');

type Exit = { code: number | null; signal: NodeJS.Signals | null };

/** A `serve --http --port 0` child on the fixture index, with its stderr collected as it arrives. */
type Served = {
  child: ChildProcessByStdio<null, null, Readable>;
  /** Everything the child has written to stderr so far. */
  stderr: () => string;
  /** The URL the startup line names. It rejects if the child exits before writing that line. */
  listening: Promise<URL>;
  /** The child's exit, once its stderr has closed too. */
  exited: Promise<Exit>;
};

/** Every child spawned here, so the hook below can end the ones a test left running. */
const spawned = new Set<Served>();

function spawnServer(): Served {
  const child = spawn(process.execPath, ['dist/index.js', 'serve', '--http', '--port', '0'], {
    cwd: process.cwd(),
    env: { ...process.env, TIBIAWIKI_MCP_DB: FIXTURE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  const exited = new Promise<Exit>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const listening = new Promise<URL>((resolve, reject) => {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      // Complete lines only, so a line still arriving cannot match with its version cut short.
      const port = STARTUP.exec(stderr.slice(0, stderr.lastIndexOf('\n') + 1))?.[1];
      if (port !== undefined) resolve(new URL(`http://127.0.0.1:${port}/mcp`));
    });
    void exited.then(() => reject(new Error(`the server exited before its startup line, stderr:\n${stderr}`)));
  });
  // A test that fails before awaiting it must not also report an unhandled rejection.
  listening.catch(() => {});
  const served = { child, stderr: () => stderr, listening, exited };
  spawned.add(served);
  return served;
}

/** Kills the child if it is still running, and waits until it has exited. */
async function end({ child, exited }: Served): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
}

// Each test ends its child in a finally, but a test that times out never gets there, and a child still
// running would hold this file's process open, so the run would hang instead of failing.
after(() => Promise.all([...spawned].map(end)));

/** `promise`, or a failure with `message` once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const timeout = delay(ms, undefined, { ref: false }).then(() => {
    throw new Error(message);
  });
  return Promise.race([promise, timeout]);
}

/** The built binary run to completion, reading `db` as its index. */
function cli(args: string[], db = FIXTURE) {
  return spawnSync(process.execPath, ['dist/index.js', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, TIBIAWIKI_MCP_DB: db },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

test('serve --http announces the address it bound, and client 2.0.0 lists the tools there', { timeout: 30_000 }, async () => {
  const handle = openDb(FIXTURE);
  const { generatedAt, version } = handle.provenance;
  handle.close();
  const server = spawnServer();
  try {
    const url = await server.listening;
    assert.equal(
      STARTUP.exec(server.stderr())?.[0],
      `tibiawiki-mcp listening on ${url}, index generated ${generatedAt} by tibiawiki-sql ${version}`,
    );
    const client = new Client({ name: 'serve-http-cli-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, TOOL_NAMES.length);
    } finally {
      await client.close();
    }
  } finally {
    await end(server);
  }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`serve --http exits 0 within 15 s of ${signal}`, { timeout: 30_000 }, async () => {
    const server = spawnServer();
    try {
      await server.listening;
      server.child.kill(signal);
      const exit = await within(server.exited, 15_000, `the server was still running 15 s after ${signal}`);
      assert.deepEqual(exit, { code: 0, signal: null }, `stderr was: ${server.stderr()}`);
    } finally {
      await end(server);
    }
  });
}

/** A legacy-era tools/list, which a stateless server answers with no handshake. */
const toolsList = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list' });

/**
 * How many tools/list requests the batch carries. At one answer of about 30 KB, 512 answers come to about
 * 15 MB, and the batch itself to about 25 KB, under the body cap.
 */
const BATCH = 512;

/**
 * The least the batch's answer may add up to: more than loopback socket buffers hold on macOS and on Linux,
 * so the answer is still being written, and the drain still waiting for it, when the second signal comes.
 */
const MIN_BATCH_ANSWER_BYTES = 13_000_000;

/** The headers a legacy POST needs to reach the handler: the bound Host, JSON, the dual Accept and the era. */
function legacyHeaders(port: number, body: string): Record<string, string> {
  return {
    Host: `127.0.0.1:${port}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-11-25',
    'Content-Length': String(Buffer.byteLength(body)),
  };
}

/** The size in bytes of the whole answer body to one legacy POST of `body`, which comes as SSE. */
function answerBytes(port: number, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: legacyHeaders(port, body), agent: false },
      (incoming) => {
        let bytes = 0;
        incoming.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
        });
        incoming.on('end', () => {
          if (incoming.statusCode === 200) resolve(bytes);
          else reject(new Error(`the answer was ${incoming.statusCode}`));
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

/** The status of a GET /ping on a connection of its own. */
function pingStatus(port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path: '/ping', agent: false }, (incoming) => {
      incoming.resume();
      incoming.on('end', () => resolve(incoming.statusCode));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/**
 * Resolves once a new request is told 503. The drain sets that as the shutdown handler calls close(), right
 * after the handler has taken the other signal's listener away, so a 503 shows the first signal was handled.
 */
async function drainBegun(port: number): Promise<void> {
  while ((await pingStatus(port)) !== 503) await delay(10);
}

/** The status line and headers of the first answer on `socket`. Once they have arrived, the socket stops reading. */
function head(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const read = (data: Buffer) => {
      received = Buffer.concat([received, data]);
      const blank = received.indexOf('\r\n\r\n');
      if (blank === -1) return;
      socket.pause();
      socket.off('data', read);
      resolve(received.subarray(0, blank).toString('latin1'));
    };
    socket.on('data', read);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('the connection closed before the head of the answer arrived')));
  });
}

// A second Ctrl-C is SIGINT twice. process.once takes the first signal's own listener away, and the handler
// takes the other signal's, so a second signal of either kind, after either first one, gets Node's default
// action.
for (const first of ['SIGTERM', 'SIGINT'] as const) {
  for (const second of ['SIGTERM', 'SIGINT'] as const) {
    test(`${second} during the drain that ${first} began ends the process at once, by ${second}`, { timeout: 30_000 }, async () => {
      const server = spawnServer();
      let socket: Socket | undefined;
      try {
        const port = Number((await server.listening).port);
        const single = await answerBytes(port, JSON.stringify(toolsList(1)));
        assert.ok(
          BATCH * single >= MIN_BATCH_ANSWER_BYTES,
          `${BATCH} answers of ${single} bytes come to less than ${MIN_BATCH_ANSWER_BYTES} bytes, so raise BATCH`,
        );
        const body = JSON.stringify(Array.from({ length: BATCH }, (_, index) => toolsList(index + 1)));
        assert.ok(Buffer.byteLength(body) <= MAX_BODY_BYTES, `the batch is ${Buffer.byteLength(body)} bytes, over the body cap`);

        socket = connect(port, '127.0.0.1');
        const answered = head(socket);
        const fields = Object.entries(legacyHeaders(port, body)).map(([name, value]) => `${name}: ${value}\r\n`);
        socket.write(`POST /mcp HTTP/1.1\r\n${fields.join('')}\r\n${body}`);
        const status = await answered;
        assert.match(status, /^HTTP\/1\.1 200 /);
        assert.match(status, /^content-type: text\/event-stream\r?$/im);

        const signalled = performance.now();
        const deadline = signalled + 5_000;
        server.child.kill(first);
        // Observed, not assumed from the 200 ms below. Were both signals still queued when the first was handled,
        // the second one's listener would go before that signal was dispatched, and the signal would be lost.
        await within(drainBegun(port), deadline - performance.now(), `the drain had not begun 5 s after ${first}`);
        await delay(Math.max(0, signalled + 200 - performance.now()));
        server.child.kill(second);
        const exit = await within(server.exited, deadline - performance.now(), `the server was still running 5 s after ${first}`);
        assert.deepEqual(exit, { code: null, signal: second }, `stderr was: ${server.stderr()}`);
      } finally {
        socket?.destroy();
        await end(server);
      }
    });
  }
}

test('serve --http exits 1 with the reason when the index is missing, and never listens', () => {
  const path = join(scratch(), 'absent.db');
  let reason = '';
  assert.throws(() => openDb(path), (error: unknown) => {
    reason = (error as Error).message;
    return true;
  });
  const run = cli(['serve', '--http', '--port', '0'], path);
  assert.equal(run.status, 1, `stderr was: ${run.stderr}`);
  assert.ok(run.stderr.split('\n').includes(`tibiawiki-mcp: ${reason}`), `stderr was: ${run.stderr}`);
  assert.doesNotMatch(run.stderr, /listening on/);
});

test('serve --http exits 1 and names the address when the port is taken', async () => {
  const holder = createNetServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address() as AddressInfo;
  try {
    const run = cli(['serve', '--http', '--port', String(port)]);
    assert.equal(run.status, 1, `stderr was: ${run.stderr}`);
    assert.ok(run.stderr.includes(`tibiawiki-mcp: cannot listen on 127.0.0.1:${port}: `), `stderr was: ${run.stderr}`);
    assert.match(run.stderr, /EADDRINUSE/);
    assert.doesNotMatch(run.stderr, /listening on/);
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});

for (const { args, reason } of [
  { args: ['--port', '9999'], reason: /need --http/ },
  { args: ['--host', '127.0.0.1'], reason: /need --http/ },
  { args: ['--http', '--port', '70000'], reason: /--port .*70000/ },
  { args: ['--http', '--port', 'abc'], reason: /--port .*abc/ },
  { args: ['--http', '--host', '[::1]'], reason: /::1 without brackets/ },
  // Node binds a zone-scoped address, but no URL can name one, so it is refused before the bind.
  { args: ['--http', '--host', 'fe80::1%en0'], reason: /^tibiawiki-mcp: --host takes an address without a zone ID such as %en0, got fe80::1%en0$/ },
  { args: ['--http', '--host', '::1%0'], reason: /without a zone ID such as %en0, got ::1%0$/ },
  { args: ['--http', '--host', ''], reason: /--host takes an address/ },
  { args: ['--http', '--host='], reason: /--host takes an address/ },
  { args: ['--http', '--bogus'], reason: /--bogus/ },
  { args: ['extra'], reason: /extra/ },
]) {
  // An empty argument is shown as '', so the test's name still says what was passed.
  const shown = args.map((arg) => (arg === '' ? "''" : arg)).join(' ');
  test(`serve ${shown} prints the reason and the usage, and exits 2`, () => {
    // Every usage error is decided before the index opens. Against a missing index, a case that stopped being
    // one still ends without binding anything: an --http case exits 1, and a stdio case exits once stdin
    // closes. It never listens until the spawn timeout.
    const run = cli(['serve', ...args], join(scratch(), 'absent.db'));
    assert.equal(run.status, 2, `stderr was: ${run.stderr}`);
    const lines = run.stderr.split('\n');
    const usage = lines.indexOf(USAGE);
    assert.ok(usage > 0, `stderr was: ${run.stderr}`);
    // The reason is the diagnostic line right before the usage.
    assert.match(lines[usage - 1] ?? '', /^tibiawiki-mcp: /);
    assert.match(lines[usage - 1] ?? '', reason);
  });
}

for (const host of ['::1', '127.0.0.1']) {
  test(`serve --http --host ${host} passes the flag check`, () => {
    // Against a missing index, an accepted host ends at the index, exit 1 with its reason and no usage,
    // before anything binds. A refused one would exit 2 with the usage instead.
    const run = cli(['serve', '--http', '--host', host, '--port', '0'], join(scratch(), 'absent.db'));
    assert.equal(run.status, 1, `stderr was: ${run.stderr}`);
    assert.doesNotMatch(run.stderr, /--host|Usage:|listening on/, `stderr was: ${run.stderr}`);
  });
}
