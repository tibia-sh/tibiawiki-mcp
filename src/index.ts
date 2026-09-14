#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { openDb } from './db.ts';
import { createServer, createUnavailableServer } from './server.ts';

const USAGE = 'Usage: tibiawiki-mcp [serve|build-index|index-digest <path>]';
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

if (command === 'build-index') {
  const { buildIndex } = await import('./indexer/build-index.ts');
  try {
    const path = await buildIndex();
    process.stderr.write(`Index written to ${path}\n`);
  } catch (error) {
    reportError((error as Error).message, 1);
  }
} else if (command === 'index-digest') {
  // Captured by the data repo's drift job, so stdout carries the digest and nothing else.
  const [path, ...extra] = process.argv.slice(3);
  if (!path || extra.length > 0) {
    reportError(`index-digest takes exactly one index path\n${USAGE}`, 2);
  } else {
    const { indexDigest } = await import('./indexer/digest.ts');
    try {
      process.stdout.write(`${indexDigest(path)}\n`);
    } catch (error) {
      reportError((error as Error).message, 1);
    }
  }
} else if (command === 'serve') {
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
} else {
  reportError(`Unknown command: ${command}\n${USAGE}`, 2);
}
