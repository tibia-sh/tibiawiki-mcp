import { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { openDb } from '../src/db.ts';
import { createServer } from '../src/server.ts';

export const FIXTURE = new URL('./fixtures/tibiawiki-fixture.db', import.meta.url).pathname;

/** The version package.json declares, which is the version npm publishes. */
export const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/**
 * A source of temp directories that are removed when the calling file's tests finish.
 *
 * Call it once per prefix at module scope and use the returned factory wherever a
 * scratch directory is needed; it registers the `after` hook itself, so no call site
 * has to remember the cleanup. The hook runs even when a test fails, which is the
 * point: a bare `mkdtempSync` left 8,000+ `twmcp-*` directories in $TMPDIR, one per
 * scratch database ever built. `scripts/decode-spell-areas.ts` pairs its own
 * `mkdtempSync` with `rmSync` in a `finally` for the same reason - this is that
 * pairing, hoisted to where a whole file's worth of directories can share it.
 */
export function tempDirs(prefix: string): () => string {
  const created: string[] = [];
  after(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
  };
}

/**
 * A real MCP client wired to a real server over the SDK's in-memory transport.
 * No subprocess, no port, and no HTTP-shaped glue around an in-process call.
 * Protocol-era conformance is covered separately by the stdio test in Task 10.
 */
export async function connect() {
  return connectTo(FIXTURE);
}

/**
 * Runs `fn` with a client on the real packaged index, for tests that need rows the
 * fixture does not keep. Those tests assert facts that later data releases do not
 * change, and membership rather than position.
 */
export async function withRealIndex<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const h = await connectTo(DB_PATH);
  try {
    return await fn(h.client);
  } finally {
    await h.close();
  }
}

async function connectTo(path: string) {
  const handle = openDb(path);
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
