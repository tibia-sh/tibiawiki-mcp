import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { hostHeaderValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, localhostAllowedHostnames, type McpServer } from '@modelcontextprotocol/server';

/**
 * Streamable HTTP in front of the SDK's MCP handler. It serves both protocol eras statelessly, refuses
 * listen streams, caps request bodies, guards loopback binds against DNS rebinding, drains without losing
 * an accepted answer, and never logs client data.
 */

/**
 * The largest body a POST to /mcp may declare. The adapter buffers a whole body with no limit of its own,
 * so the cap is checked on Content-Length before a byte of the body is read.
 */
export const MAX_BODY_BYTES = 65_536;

export type HttpServeOptions = {
  /** The address to bind. */
  host: string;
  /** The port to bind. 0 binds an ephemeral port. */
  port: number;
  /** Receives status lines, without a trailing newline. */
  log: (line: string) => void;
  /** How long close() waits for accepted requests, 10 s unless set. */
  graceMs?: number;
};

export type HttpServing = {
  /** http://<bound address>:<bound port>/mcp, an IPv6 address bracketed. */
  readonly url: URL;
  /** The drain. A second call returns the same promise. */
  close(): Promise<void>;
};

const DEFAULT_GRACE_MS = 10_000;

/** How much longer than the rest of the grace close() waits for handler.close(), before it stops the server anyway. */
const HANDLER_CLOSE_MARGIN_MS = 1_000;

/**
 * The longest grace close() can keep. Node runs a timer longer than 2^31 - 1 ms after 1 ms instead, and the
 * handler margin is added to what remains of the grace.
 */
const MAX_GRACE_MS = 2 ** 31 - 1 - HANDLER_CLOSE_MARGIN_MS;

/** A dotted-quad IPv4 address in 127.0.0.0/8. */
const LOOPBACK_IPV4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Whether an address, as server.address() reports it, is loopback: ::1, 127.0.0.0/8, or 127.0.0.0/8 mapped
 * into IPv6. A name is never loopback here, because server.address() reports none.
 */
export function isLoopbackAddress(address: string): boolean {
  const ipv4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return address === '::1' || LOOPBACK_IPV4.test(ipv4);
}

/** A host as a URL carries it, with an IPv6 address bracketed. */
function bracketed(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

/** A plain-text answer, sent before any byte of the request body is read. */
function answer(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res
    .writeHead(status, { ...headers, 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(text)) })
    .end(text);
}

/**
 * Serves `factory`'s tools at /mcp on `options.host` and `options.port`, and answers GET /ping for health
 * checks. It resolves once listening, and rejects with the listen error after releasing the handler. A grace
 * outside 0 to MAX_GRACE_MS is refused with a RangeError before anything starts.
 */
export async function serveHttp(factory: () => McpServer, options: HttpServeOptions): Promise<HttpServing> {
  const { host, port, log, graceMs = DEFAULT_GRACE_MS } = options;
  if (!(graceMs >= 0 && graceMs <= MAX_GRACE_MS)) {
    throw new RangeError(`graceMs must be from 0 to ${MAX_GRACE_MS}, got ${graceMs}`);
  }
  const handler = createMcpHandler(factory, { legacy: 'stateless', responseMode: 'json', maxSubscriptions: 0 });
  const serveMcp = toNodeHandler(handler);

  /** Set by close(). From then on every request, on a new connection or an open one, is told 503. */
  let draining = false;
  /** The Host and Origin guards. They are set once listening, and only when the bound address is loopback. */
  let guards: Array<(req: IncomingMessage, res: ServerResponse) => boolean> = [];
  /** Requests handed to the handler whose responses have not closed yet. */
  let accepted = 0;
  /** Wakes the drain once the last accepted request has closed. */
  let onIdle: (() => void) | undefined;

  const server = createServer((req, res) => {
    // Node emits `request` for a pipelined request as soon as it is parsed, so one parsed before the
    // drain began was accepted, and one parsed after it is told 503 here.
    if (draining) return answer(res, 503, 'shutting down', { connection: 'close' });
    const path = (req.url ?? '').split('?', 1)[0];
    if (req.method === 'GET' && path === '/ping') return answer(res, 200, 'ok');
    if (path !== '/mcp') return answer(res, 404, 'not found');
    // A guard that refuses has already answered 403.
    if (!guards.every((guard) => guard(req, res))) return;
    // The adapter reads the body of every method but GET and HEAD, so any other method would slip past the cap.
    if (req.method !== 'GET' && req.method !== 'POST') {
      return answer(res, 405, 'method not allowed', { allow: 'GET, POST' });
    }
    if (req.method === 'POST') {
      // Node's parser holds a body to its declared length, so a declared length is a real bound.
      const length = req.headers['content-length'];
      if (length === undefined) return answer(res, 411, 'length required');
      if (Number(length) > MAX_BODY_BYTES) return answer(res, 413, 'content too large');
    }

    const started = performance.now();
    accepted += 1;
    res.once('close', () => {
      accepted -= 1;
      // SDK error messages quote client values, so a failure is logged as its status alone.
      if (res.statusCode >= 500) {
        const ms = Math.round(performance.now() - started);
        log(`tibiawiki-mcp: ${req.method} /mcp answered ${res.statusCode} in ${ms} ms`);
      }
      if (accepted === 0) onIdle?.();
    });
    // The adapter answers its own failures with 500. Anything that still escapes it ends this response
    // rather than the process.
    serveMcp(req, res).catch(() => res.destroy());
  });

  /** Listens, then decides the guards once on the address actually bound, and returns the URL it serves. */
  const listen = async (): Promise<URL> => {
    server.listen(port, host);
    await once(server, 'listening');
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error(`expected a TCP address, got ${String(address)}`);
    }
    const url = new URL(`http://${bracketed(address.address)}:${address.port}/mcp`);
    // 127.1 binds 127.0.0.1, so the host string cannot decide. The Host guard compares the hostname a URL
    // parser reads from the header, so the given host and the bound address are listed in that same form.
    if (isLoopbackAddress(address.address)) {
      const given = new URL(`http://${bracketed(host)}`).hostname;
      guards = [
        hostHeaderValidation([...localhostAllowedHostnames(), given, url.hostname]),
        localhostOriginValidation(),
      ];
    }
    return url;
  };

  const url = await listen().catch(async (error: unknown) => {
    server.close();
    await handler.close();
    throw error;
  });

  /**
   * Stops admitting, waits for accepted requests within the grace, then closes the handler and the server,
   * in that order. handler.close() ends every modern exchange still in flight and makes the adapter answer
   * 500 from then on, so it waits for accepted requests. server.close() closes idle connections at once,
   * including one whose answer is still flushing and one that could still be told 503, so it comes last.
   */
  const drain = async (): Promise<void> => {
    draining = true;
    const deadline = performance.now() + graceMs;
    // Unreferenced timers, so a drain that finished early leaves nothing holding the process open.
    if (accepted > 0) {
      const idle = new Promise<void>((resolve) => {
        onIdle = resolve;
      });
      await Promise.race([idle, delay(graceMs, undefined, { ref: false })]);
    }
    await Promise.race([
      handler.close().catch(() => {}),
      delay(Math.max(0, deadline - performance.now()) + HANDLER_CLOSE_MARGIN_MS, undefined, { ref: false }),
    ]);
    const stopped = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    server.closeAllConnections();
    await stopped;
  };

  let closing: Promise<void> | undefined;
  return {
    url,
    close: () => (closing ??= drain()),
  };
}
