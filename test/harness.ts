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

/**
 * Ceiling on the serialised size of `tools/list`, in bytes.
 *
 * This is a self-imposed budget, not an MCP limit. It exists because `tools/list`
 * is sent to the model at the start of every session, so it is a standing charge
 * against the agent's context: at roughly four characters per token, 40,000 bytes
 * is about 10,000 tokens.
 *
 * Raised from 30,000 on 2026-09-12, when spell area shapes landed at 29,855 and left
 * 145 bytes. The measured breakdown is that `tibia_get`'s outputSchema is ~20,000 of
 * the total - two thirds - because it is a fourteen-member discriminated union. That
 * is inherent to describing fourteen entity types honestly, not slack to reclaim, so
 * the right response was a higher ceiling rather than a thinner schema.
 *
 * If this is approached again, weigh trimming `tibia_get` (or splitting it) before
 * raising it further: the number is meant to force that conversation, not to slide.
 */
export const TOOLS_LIST_BUDGET = 40_000;
