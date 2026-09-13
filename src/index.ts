#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { openDb } from './db.ts';
import { createServer, createUnavailableServer } from './server.ts';

const USAGE = 'Usage: tibiawiki-mcp [serve|build-index|index-digest <path>]';
const command = process.argv[2] ?? 'serve';

// Failures set exitCode rather than calling exit(), which can drop a write still pending
// on a pipe, and a pipe is how a script reads this output.
if (command === 'build-index') {
  const { buildIndex } = await import('./indexer/build-index.ts');
  try {
    const path = await buildIndex();
    process.stderr.write(`Index written to ${path}\n`);
  } catch (error) {
    process.stderr.write(`tibiawiki-mcp: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
} else if (command === 'index-digest') {
  // Captured by the data repo's drift job, so stdout carries the digest and nothing else.
  const [path, ...extra] = process.argv.slice(3);
  if (!path || extra.length > 0) {
    process.stderr.write(`index-digest takes exactly one index path\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    const { indexDigest } = await import('./indexer/digest.ts');
    try {
      process.stdout.write(`${indexDigest(path)}\n`);
    } catch (error) {
      process.stderr.write(`tibiawiki-mcp: ${(error as Error).message}\n`);
      process.exitCode = 1;
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
    process.stderr.write(`tibiawiki-mcp: ${reason}\n`);
    serveStdio(() => createUnavailableServer(reason));
  }
} else {
  process.stderr.write(`Unknown command: ${command}\n${USAGE}\n`);
  process.exitCode = 2;
}
