#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { openDb, type TibiaDb } from './db.ts';
import type { HttpServing } from './http.ts';
import { createServer, createUnavailableServer } from './server.ts';

const USAGE = 'Usage: tibiawiki-mcp [serve [--http [--host <address>] [--port <number>]]|build-index]';
const command = process.argv[2] ?? 'serve';

/**
 * Every failure here is reported through this, as one `tibiawiki-mcp: ` diagnostic on stderr.
 * It sets exitCode rather than calling exit(), which can drop a write still pending on a
 * pipe, and a pipe is how a script reads this output. Without a code the exit status is left
 * alone, for a failure the process carries on past.
 */
function reportError(message: string, exitCode?: 1 | 2): void {
  process.stderr.write(`tibiawiki-mcp: ${message}\n`);
  if (exitCode !== undefined) process.exitCode = exitCode;
}

type ServeFlags = { http: false } | { http: true; host: string; port: number };

/** The flags `serve` was given, or the reason they are a usage error. */
function parseServeFlags(args: string[]): ServeFlags | string {
  let values: { http?: boolean; host?: string; port?: string };
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: { http: { type: 'boolean' }, host: { type: 'string' }, port: { type: 'string' } },
    }));
  } catch (error) {
    return (error as Error).message;
  }
  if (!values.http) {
    return values.host === undefined && values.port === undefined ? { http: false } : '--host and --port need --http';
  }
  const { host = '127.0.0.1', port = '8080' } = values;
  // 0 binds an ephemeral port, which the startup line reports.
  if (!/^\d+$/.test(port) || Number(port) > 65_535) return `--port takes a number from 0 to 65535, got ${port}`;
  // listen() reads an empty host as none and binds every interface, where the loopback guards never run.
  if (host === '') return '--host takes an address, got an empty string';
  // listen() cannot resolve a bracketed address, so the brackets are the URL's to add.
  if (host.includes('[') || host.includes(']')) {
    return `--host takes an IPv6 address such as ::1 without brackets, got ${host}`;
  }
  // A URL has no way to carry a zone ID, so the URL the server announces and guards cannot be built
  // for one. listen() would bind the address, then fail on that URL with an error naming neither.
  if (host.includes('%')) return `--host takes an address without a zone ID such as %en0, got ${host}`;
  return { http: true, host, port: Number(port) };
}

/**
 * `serve --http`. Unlike stdio it fails fast: an index it cannot open, or an address it cannot bind,
 * exits 1 with the reason, so a container with a bad index never becomes healthy.
 */
async function serveOverHttp(host: string, port: number): Promise<void> {
  // Loaded before the index opens, so no failure path is left holding an open index.
  const { serveHttp } = await import('./http.ts');
  let handle: TibiaDb;
  try {
    handle = openDb();
  } catch (error) {
    reportError((error as Error).message, 1);
    return;
  }
  let serving: HttpServing;
  try {
    serving = await serveHttp(() => createServer(handle), {
      host,
      port,
      log: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    reportError(`cannot listen on ${host}:${port}: ${(error as Error).message}`, 1);
    handle.close();
    return;
  }
  // One drain, and the index closed once. The first signal takes the other signal's listener away, so a
  // second signal of either kind gets Node's default action and ends the process at once, as a second
  // Ctrl-C should.
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    process.off(signal === 'SIGTERM' ? 'SIGINT' : 'SIGTERM', shutdown);
    await serving.close();
    handle.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  // Written once the signals are handled, so anything that waits for this line can stop the server.
  const { generatedAt, version } = handle.provenance;
  process.stderr.write(`tibiawiki-mcp listening on ${serving.url}, index generated ${generatedAt} by tibiawiki-sql ${version}\n`);
}

if (command === 'build-index') {
  const { buildIndex } = await import('./indexer/build-index.ts');
  try {
    const path = await buildIndex();
    process.stderr.write(`Index written to ${path}\n`);
  } catch (error) {
    reportError((error as Error).message, 1);
  }
} else if (command === 'serve') {
  const flags = parseServeFlags(process.argv.slice(3));
  if (typeof flags === 'string') {
    reportError(`${flags}\n${USAGE}`, 2);
  } else if (flags.http) {
    await serveOverHttp(flags.host, flags.port);
  } else {
    // Opened once and shared: the index is read-only and immutable for the process.
    // A bad index must NOT exit - an MCP host would report only "Connection closed"
    // and lose the reason. Serve the failure through the protocol instead.
    try {
      const handle = openDb();
      serveStdio(() => createServer(handle));
    } catch (error) {
      const reason = (error as Error).message;
      reportError(reason);
      serveStdio(() => createUnavailableServer(reason));
    }
  }
} else {
  reportError(`Unknown command: ${command}\n${USAGE}`, 2);
}
