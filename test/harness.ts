import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { openDb } from '../src/db.ts';
import { createServer } from '../src/server.ts';

export const FIXTURE = new URL('./fixtures/tibiawiki-fixture.db', import.meta.url).pathname;

/**
 * A real MCP client wired to a real server over the SDK's in-memory transport.
 * No subprocess, no port, and no HTTP-shaped glue around an in-process call.
 * Protocol-era conformance is covered separately by the stdio test in Task 10.
 */
export async function connect() {
  const handle = openDb(FIXTURE);
  const server = createServer(handle);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-harness', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
      handle.close();
    },
  };
}
