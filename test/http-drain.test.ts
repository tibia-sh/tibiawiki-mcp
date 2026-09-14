import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { serveHttp, type HttpServing } from '../src/http.ts';

/**
 * The shutdown guarantees of src/http.ts, over raw sockets, so a test controls pipelining, when a body
 * is sent and whether the client reads. A request is proven admitted before close() is called by
 * something the client or the server observes, never by a sleep: its held handler has started, the client
 * has received 100 Continue (Node emits `request` before that interim answer reaches the client), or the
 * client has received the headers of its bulk answer.
 */

const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';

/** 16 MiB: more than loopback socket buffers hold, so the answer stays unfinished while the client does not read. */
const BULK_TEXT = 'x'.repeat(16 * 1024 * 1024);

type Head = { status: number; headers: Record<string, string> };
type Answer = Head & { body: Buffer };

/** What the reader waits for next in the byte stream. */
type Framing =
  | { kind: 'head' }
  | { kind: 'length'; head: Head; length: number }
  | { kind: 'chunk-size'; head: Head; parts: Buffer[] }
  | { kind: 'chunk-data'; head: Head; parts: Buffer[]; size: number }
  | { kind: 'chunk-end'; head: Head; parts: Buffer[] };

/**
 * One client connection: raw writes, and the HTTP/1.1 answers read back in order, interim 100 Continue
 * included. Every answer here is framed by Content-Length or chunked encoding, with no trailers.
 */
class Wire {
  readonly socket: Socket;
  /** Resolves when the socket emits 'close'. */
  readonly closed: Promise<void>;
  private readonly heads: Head[] = [];
  private readonly answers: Answer[] = [];
  private continues = 0;
  private ended = false;
  private failure: Error | undefined;
  private pending: Buffer[] = [];
  private pendingLength = 0;
  private framing: Framing = { kind: 'head' };
  private readonly waiters = new Set<() => void>();

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (data: Buffer) => {
      this.pending.push(data);
      this.pendingLength += data.length;
      while (this.step());
      this.notify();
    });
    // A reset ends in 'close' too, where every waiter still pending fails with this error named.
    socket.on('error', (error) => {
      this.failure = error;
    });
    this.closed = new Promise((resolve) => {
      socket.once('close', () => {
        this.ended = true;
        this.notify();
        resolve();
      });
    });
  }

  /** A connection to the server on 127.0.0.1, once connected. */
  static open(port: number): Promise<Wire> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(new Wire(socket));
      });
    });
  }

  /** The head of the answer at `index`, once its status line and headers have arrived. */
  head(index: number): Promise<Head> {
    return this.until(() => this.heads[index], `the head of answer ${index} arrived`);
  }

  /** The answer at `index`, once its whole body has arrived. */
  answer(index: number): Promise<Answer> {
    return this.until(() => this.answers[index], `answer ${index} completed`);
  }

  /** Resolves once an interim 100 Continue has arrived. */
  async continued(): Promise<void> {
    await this.until(() => (this.continues > 0 ? true : undefined), 'a 100 Continue arrived');
  }

  private until<T>(found: () => T | undefined, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const value = found();
        if (value !== undefined) {
          this.waiters.delete(check);
          resolve(value);
        } else if (this.ended) {
          this.waiters.delete(check);
          reject(new Error(`the connection closed before ${what}${this.failure ? ` (${this.failure.message})` : ''}`));
        }
      };
      this.waiters.add(check);
      check();
    });
  }

  private notify(): void {
    for (const check of [...this.waiters]) check();
  }

  /** Parses one step from the pending bytes, or returns false when the step needs more of them. */
  private step(): boolean {
    const framing = this.framing;
    switch (framing.kind) {
      case 'head': {
        const end = this.find('\r\n\r\n');
        if (end === -1) return false;
        const [statusLine = '', ...fields] = this.take(end + 4).toString('latin1').slice(0, end).split('\r\n');
        const headers: Record<string, string> = {};
        for (const field of fields) {
          const colon = field.indexOf(':');
          headers[field.slice(0, colon).trim().toLowerCase()] = field.slice(colon + 1).trim();
        }
        const head = { status: Number(statusLine.split(' ')[1]), headers };
        if (head.status === 100) {
          this.continues += 1;
          return true;
        }
        this.heads.push(head);
        this.framing = headers['transfer-encoding'] === 'chunked'
          ? { kind: 'chunk-size', head, parts: [] }
          : { kind: 'length', head, length: Number(headers['content-length'] ?? 0) };
        return true;
      }
      case 'length': {
        if (this.pendingLength < framing.length) return false;
        this.complete(framing.head, this.take(framing.length));
        return true;
      }
      case 'chunk-size': {
        const end = this.find('\r\n');
        if (end === -1) return false;
        const size = Number.parseInt(this.take(end + 2).toString('latin1'), 16);
        this.framing = size === 0
          ? { kind: 'chunk-end', head: framing.head, parts: framing.parts }
          : { kind: 'chunk-data', head: framing.head, parts: framing.parts, size };
        return true;
      }
      case 'chunk-data': {
        if (this.pendingLength < framing.size + 2) return false;
        framing.parts.push(this.take(framing.size));
        this.take(2);
        this.framing = { kind: 'chunk-size', head: framing.head, parts: framing.parts };
        return true;
      }
      case 'chunk-end': {
        if (this.pendingLength < 2) return false;
        this.take(2);
        this.complete(framing.head, Buffer.concat(framing.parts));
        return true;
      }
    }
  }

  private complete(head: Head, body: Buffer): void {
    this.answers.push({ ...head, body });
    this.framing = { kind: 'head' };
  }

  private find(sequence: string): number {
    if (this.pending.length > 1) this.pending = [Buffer.concat(this.pending, this.pendingLength)];
    return this.pending[0]?.indexOf(sequence) ?? -1;
  }

  private take(count: number): Buffer {
    const all = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending, this.pendingLength);
    this.pending = count < all.length ? [all.subarray(count)] : [];
    this.pendingLength -= count;
    return all.subarray(0, count);
  }
}

/** A POST to /mcp with the headers every request that reaches the handler sends, then `extra`. */
function post(port: number, era: string, message: object, extra: Record<string, string> = {}) {
  const body = JSON.stringify(message);
  const fields = {
    Host: `127.0.0.1:${port}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': era,
    'Content-Length': String(Buffer.byteLength(body)),
    ...extra,
  };
  const head = `POST /mcp HTTP/1.1\r\n${Object.entries(fields).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`;
  return { head, body };
}

/** A modern-era request as a negotiating client 2.0.0 sends it, whole. */
function modern(
  port: number,
  id: number,
  method: string,
  params: Record<string, unknown>,
  extra: Record<string, string> = {},
): string {
  const envelope = {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientInfo': { name: 'http-drain-test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const message = { jsonrpc: '2.0', id, method, params: { ...params, _meta: envelope } };
  const { head, body } = post(port, MODERN, message, { 'Mcp-Method': method, ...extra });
  return head + body;
}

/** A modern tools/call of `name`. */
function call(port: number, id: number, name: string, args: Record<string, unknown>): string {
  return modern(port, id, 'tools/call', { name, arguments: args }, { 'Mcp-Name': name });
}

/** The content of the tool result a modern JSON answer carries. */
function content(answer: Answer): Array<{ type: string; text: string }> {
  return (JSON.parse(answer.body.toString()) as { result: { content: Array<{ type: string; text: string }> } }).result.content;
}

/** The held gates of one server: the test opens each, and each reports when its handler started. */
function gates() {
  const all = new Map<string, { started: () => void; opened: Promise<void>; release: () => void }>();
  /** Registers the gate a held call with `key` waits at. */
  const gate = (key: string) => {
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    all.set(key, { started, opened, release });
    return { started: startedPromise, release };
  };
  /** Opens every gate, so a failed test leaves no handler waiting. */
  const releaseAll = () => {
    for (const entry of all.values()) entry.release();
  };

  /** A fresh server per call, with the drain tests' two tools. */
  const factory = (): McpServer => {
    const server = new McpServer({ name: 'http-drain-test', version: '1.0.0' });
    server.registerTool('held', { inputSchema: z.object({ key: z.string() }) }, async ({ key }) => {
      const entry = all.get(key);
      if (entry === undefined) throw new Error(`no gate registered for ${key}`);
      entry.started();
      await entry.opened;
      return { content: [{ type: 'text', text: key }] };
    });
    server.registerTool('bulk', { inputSchema: z.object({}) }, () => ({ content: [{ type: 'text', text: BULK_TEXT }] }));
    return server;
  };
  return { gate, releaseAll, factory };
}

/** Serves `factory` on 127.0.0.1 with an ephemeral port, logging nothing. */
function serve(factory: () => McpServer, graceMs?: number): Promise<HttpServing> {
  return serveHttp(factory, { host: '127.0.0.1', port: 0, log: () => {}, ...(graceMs === undefined ? {} : { graceMs }) });
}

/** `promise`, and whether it has settled yet. */
function watch(promise: Promise<void>) {
  const watched = { promise, settled: false };
  promise.then(
    () => {
      watched.settled = true;
    },
    () => {
      watched.settled = true;
    },
  );
  return watched;
}

test('an accepted modern request completes, and close() waits for it', async () => {
  const { gate, releaseAll, factory } = gates();
  const serving = await serve(factory);
  const port = Number(serving.url.port);
  const wire = await Wire.open(port);
  try {
    const held = gate('one');
    wire.socket.write(call(port, 1, 'held', { key: 'one' }));
    await held.started;
    const closing = watch(serving.close());
    await delay(200);
    // Checked right before the gate opens, so close() cannot have settled on the answer it waits for.
    assert.equal(closing.settled, false, 'close() settled while an accepted request was open');
    held.release();
    const answer = await wire.answer(0);
    assert.equal(answer.status, 200);
    assert.deepEqual(content(answer), [{ type: 'text', text: 'one' }]);
    await closing.promise;
  } finally {
    releaseAll();
    wire.socket.destroy();
    await serving.close();
  }
});

test('a request whose body is still arriving when the drain begins is served', async () => {
  const { releaseAll, factory } = gates();
  const serving = await serve(factory);
  const port = Number(serving.url.port);
  const wire = await Wire.open(port);
  try {
    const { head, body } = post(port, LEGACY, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Expect: '100-continue' });
    wire.socket.write(head);
    await wire.continued();
    const closing = serving.close();
    wire.socket.write(body);
    const answer = await wire.answer(0);
    // A handler closed before the body arrived would refuse the request, and the adapter would answer 500.
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['content-type'], 'text/event-stream');
    const [event = ''] = answer.body.toString().split('\n\n');
    const data = event.split('\n').find((line) => line.startsWith('data: '))?.slice('data: '.length) ?? '';
    const message = JSON.parse(data) as { id: number; result: { tools: Array<{ name: string }> } };
    assert.equal(message.id, 1);
    assert.deepEqual(message.result.tools.map((tool) => tool.name), ['held', 'bulk']);
    await closing;
  } finally {
    releaseAll();
    wire.socket.destroy();
    await serving.close();
  }
});

test('an idle keep-alive connection gets a complete 503 during the drain, while an accepted request completes', async () => {
  const { gate, releaseAll, factory } = gates();
  const serving = await serve(factory);
  const port = Number(serving.url.port);
  const holding = await Wire.open(port);
  const idle = await Wire.open(port);
  try {
    const held = gate('held');
    holding.socket.write(call(port, 1, 'held', { key: 'held' }));
    await held.started;
    idle.socket.write(modern(port, 1, 'tools/list', {}));
    assert.equal((await idle.answer(0)).status, 200);

    const closing = serving.close();
    // server.close() would already have closed this idle connection, and this request would get nothing.
    idle.socket.write(modern(port, 2, 'tools/list', {}));
    const refused = await idle.answer(1);
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.connection, 'close');
    assert.equal(refused.headers['content-type'], 'text/plain');
    assert.equal(refused.body.toString(), 'shutting down');
    await idle.closed;

    held.release();
    const answer = await holding.answer(0);
    assert.equal(answer.status, 200);
    assert.deepEqual(content(answer), [{ type: 'text', text: 'held' }]);
    await closing;
  } finally {
    releaseAll();
    holding.socket.destroy();
    idle.socket.destroy();
    await serving.close();
  }
});

test('pipelined requests accepted before the drain both complete, in order', async () => {
  const { gate, releaseAll, factory } = gates();
  const serving = await serve(factory);
  const port = Number(serving.url.port);
  const wire = await Wire.open(port);
  try {
    const first = gate('first');
    const second = gate('second');
    wire.socket.write(call(port, 1, 'held', { key: 'first' }) + call(port, 2, 'held', { key: 'second' }));
    // Both handlers running proves both requests were accepted.
    await Promise.all([first.started, second.started]);
    const closing = serving.close();
    // Opened in reverse, yet the answers must still come in the order of the requests.
    second.release();
    first.release();
    const answers = await Promise.all([wire.answer(0), wire.answer(1)]);
    assert.deepEqual(answers.map((answer) => answer.status), [200, 200]);
    assert.deepEqual(answers.map(content), [[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]]);
    await closing;
  } finally {
    releaseAll();
    wire.socket.destroy();
    await serving.close();
  }
});

test('a slow reader within the grace receives the whole answer', async () => {
  const { releaseAll, factory } = gates();
  const serving = await serve(factory, 5_000);
  const port = Number(serving.url.port);
  const wire = await Wire.open(port);
  try {
    wire.socket.write(call(port, 1, 'bulk', {}));
    await wire.head(0);
    wire.socket.pause();
    const closing = watch(serving.close());
    await delay(1_000);
    assert.equal(closing.settled, false, 'close() settled while a slow reader was still reading');
    wire.socket.resume();
    const answer = await wire.answer(0);
    assert.equal(answer.status, 200);
    const [bulk, ...rest] = content(answer);
    assert.equal(rest.length, 0);
    assert.equal(bulk?.text.length, BULK_TEXT.length);
    // Compared without assert.equal, whose failure message would print both 16 MiB strings.
    assert.ok(bulk?.text === BULK_TEXT, 'the bulk text arrived altered');
    await closing.promise;
  } finally {
    releaseAll();
    wire.socket.destroy();
    await serving.close();
  }
});

test('a client that stalls past the grace is cut off, and close() settles after the grace', async () => {
  const { releaseAll, factory } = gates();
  const graceMs = 500;
  const serving = await serve(factory, graceMs);
  const port = Number(serving.url.port);
  const wire = await Wire.open(port);
  try {
    wire.socket.write(call(port, 1, 'bulk', {}));
    await wire.head(0);
    wire.socket.pause();
    const started = performance.now();
    await serving.close();
    const elapsed = performance.now() - started;
    // A timer keeps whole milliseconds, so it can fire up to 1 ms before a fractional clock says.
    assert.ok(elapsed >= graceMs - 1, `close() settled after ${elapsed} ms, inside the ${graceMs} ms grace`);
    assert.ok(elapsed <= 2_500, `close() settled after ${elapsed} ms`);
    // A paused socket reads nothing, not even the end of the connection, so it reads again to see it.
    wire.socket.resume();
    await wire.closed;
    await assert.rejects(wire.answer(0), /closed before answer 0 completed/, 'the stalled answer was not cut off');
  } finally {
    releaseAll();
    wire.socket.destroy();
    await serving.close();
  }
});

test('close() waits the rest of the grace and 1 s for a handler.close() that never settles, then stops', async () => {
  const { gate, releaseAll, factory } = gates();
  const graceMs = 500;
  let serverCloses = 0;
  const serving = await serve(() => {
    const server = factory();
    // handler.close() closes the low-level Server of every modern exchange in flight, and waits for it.
    server.server.close = () => {
      serverCloses += 1;
      return new Promise<void>(() => {});
    };
    return server;
  }, graceMs);
  const port = Number(serving.url.port);
  const wire = await Wire.open(port);
  try {
    const held = gate('stuck');
    wire.socket.write(call(port, 1, 'held', { key: 'stuck' }));
    await held.started;
    const started = performance.now();
    const outcome = await Promise.race([
      serving.close().then(() => 'closed'),
      delay(3_000, 'still pending', { ref: false }),
    ]);
    const elapsed = performance.now() - started;
    assert.equal(outcome, 'closed');
    assert.equal(serverCloses, 1, "handler.close() did not close the held exchange's server");
    // Whole-millisecond timers can each fire a little before a fractional clock says.
    assert.ok(elapsed >= graceMs + 1_000 - 10, `close() settled after ${elapsed} ms, before the handler's bound`);
    await wire.closed;
  } finally {
    releaseAll();
    wire.socket.destroy();
  }
});

test('after close(), close() returns the same promise and a new connection is refused', async () => {
  const { factory } = gates();
  const serving = await serve(factory);
  const port = Number(serving.url.port);
  const closing = serving.close();
  assert.equal(serving.close(), closing);
  await closing;
  assert.equal(serving.close(), closing);
  await assert.rejects(Wire.open(port), { code: 'ECONNREFUSED' });
});
