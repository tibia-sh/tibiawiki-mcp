import { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client, type Tool } from '@modelcontextprotocol/client';
import { openDb, type Provenance } from '../src/db.ts';
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

/**
 * A client on the index at `path`, for tests that build a scratch copy of the fixture.
 * `provenance` stands in for the index's own, for tests that measure text it lengthens.
 */
export async function connectTo(path: string, provenance?: Provenance) {
  const handle = openDb(path);
  const server = createServer(provenance ? { ...handle, provenance } : handle);
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
 * Ceiling on what a model reads of `tools/list`, in bytes, as `measureToolsList` counts it.
 *
 * This is a self-imposed budget, not an MCP limit. A host that loads every schema pays
 * these bytes each session, and a host that defers them pays them per tool it loads: at
 * roughly four characters per token, 16,000 bytes is about 4,000 tokens. Claude Code gives
 * the model a tool's description and input parameters only, checked on 2026-09-25 by
 * loading this server's tools in a Claude Code session, and it defers MCP schemas, loading
 * tool names and server instructions at startup (https://code.claude.com/docs/en/mcp).
 * There, output schemas do not reach the model, so they do not count here. Other hosts
 * were not checked.
 *
 * On the fixture the helper measures 14,709 bytes model-facing, names included.
 * This is the number meant to force the conversation: if you approach it, trim a
 * description before you raise it. The server instructions are no escape hatch, since
 * they have their own 2,048-character cap in test/server.test.ts, and with a real
 * index's provenance they measure 1,684 characters.
 */
export const MODEL_FACING_BUDGET = 16_000;

/**
 * Ceiling on the whole serialised `tools/list`, in bytes.
 *
 * Output schemas cost Claude Code's model nothing, but some hosts load every schema into
 * context, and every client carries the full answer over the wire. On the fixture the
 * total is 54,298 bytes, 38,140 of them output schemas, most of it `tibia_get`'s
 * fourteen-member union. 64,000 is about 20% above that, which leaves room for output
 * schemas to grow while still catching runaway growth.
 */
export const TOOLS_LIST_CEILING = 64_000;

/**
 * Sizes a `tools/list` result in UTF-8 bytes. `modelFacing` sums each tool's name,
 * description and serialised input schema, what Claude Code gives the model. `total`
 * is the whole serialised list, output schemas included.
 */
export function measureToolsList(tools: readonly Tool[]): { modelFacing: number; total: number } {
  let modelFacing = 0;
  for (const tool of tools) {
    modelFacing += Buffer.byteLength(tool.name, 'utf8') +
      Buffer.byteLength(tool.description ?? '', 'utf8') +
      Buffer.byteLength(JSON.stringify(tool.inputSchema), 'utf8');
  }
  return { modelFacing, total: Buffer.byteLength(JSON.stringify(tools), 'utf8') };
}
