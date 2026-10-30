import { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
 * A copy of the fixture, in `dir`, whose Moonsilver Axe has defense "33 +3" again.
 *
 * The "numeric" item attributes are not always integers. Through data 3.4.0 three active
 * items carried a bonus suffix, Moonsilver Axe's defense "33 +3" among them. From 3.5.0
 * the wiki records that bonus as defense 33 and defense_modifier "+3", so no index holds
 * a suffixed value now. The wiki can write one again, and the tools must still read it.
 */
export function suffixedDefenseFixture(dir: string): string {
  const path = join(dir, 'index.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  const { changes } = db.prepare(
    `update item_attribute set value = '33 +3' where name = 'defense'
       and item_id = (select article_id from item where title = 'Moonsilver Axe')`,
  ).run();
  db.close();
  assert.equal(changes, 1, 'guard: the fixture holds Moonsilver Axe with one defense row');
  return path;
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
 * roughly four characters per token, 20,000 bytes is about 5,000 tokens. Claude Code gives
 * the model a tool's description and input parameters only, checked on 2026-09-25 by
 * loading this server's tools in a Claude Code session, and it defers MCP schemas, loading
 * tool names and server instructions at startup (https://code.claude.com/docs/en/mcp).
 * There, output schemas do not reach the model, so they do not count here. Other hosts
 * were not checked.
 *
 * The server instructions are no escape hatch, since they have their own 2,048-character
 * cap in test/server.test.ts, and with the date of data 3.5.0 and the longest generator
 * version a release is expected to carry (9.0.0+tibiash.99) they measure 2,032 characters.
 *
 * Budget ruling for the "Correct Data and IDs" plan, measured on the fixture cut from data
 * 3.5.0 on 2026-10-30: 12 tools with 94 inputs, at about 101 bytes an input. The plan adds
 * about 23 inputs and two tools, about 3,150 bytes model-facing:
 *
 * |              |    Now | Projected                  | With 10% |    Cap |
 * |--------------|-------:|----------------------------|---------:|-------:|
 * | Model-facing | 14,778 | about 17,900               |  ~19,700 | 20,000 |
 * | Total        | 55,031 | about 64-65k, with outputs |  ~71,000 | 80,000 |
 *
 * Each task in the plan records its measured change. A task that would cross a cap stops
 * and asks for a ruling; it never raises a cap on its own. The next plan starts with about
 * 10% headroom. Near the cap, trim a description before asking to raise it.
 */
export const MODEL_FACING_BUDGET = 20_000;

/**
 * Ceiling on the whole serialised `tools/list`, in bytes.
 *
 * Output schemas cost Claude Code's model nothing, but some hosts load every schema into
 * context, and every client carries the full answer over the wire. On the fixture cut
 * from data 3.5.0 the total is 55,031 bytes, 38,804 of them output schemas, most of it
 * `tibia_get`'s fourteen-member union. The cap comes from the ruling above
 * MODEL_FACING_BUDGET: the plan's growth, output schemas included, projects to about
 * 64-65k, about 71k with 10% on top, under 80,000.
 */
export const TOOLS_LIST_CEILING = 80_000;

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
