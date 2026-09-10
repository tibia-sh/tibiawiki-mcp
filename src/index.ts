#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { openDb } from './db.ts';
import { createServer } from './server.ts';

const command = process.argv[2] ?? 'serve';

if (command === 'build-index') {
  const { buildIndex } = await import('./indexer/build-index.ts');
  const path = await buildIndex();
  process.stderr.write(`Index written to ${path}\n`);
} else if (command === 'serve') {
  // Opened once and shared: the index is read-only and immutable for the process.
  const handle = openDb();
  serveStdio(() => createServer(handle));
} else {
  process.stderr.write(
    `Unknown command: ${command}\nUsage: tibiawiki-mcp [serve|build-index]\n`,
  );
  process.exit(2);
}
