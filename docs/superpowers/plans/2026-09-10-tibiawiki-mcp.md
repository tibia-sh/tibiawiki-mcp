# TibiaWiki MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, read-only MCP server that answers attribute queries about Tibia ("which creatures are weak to fire and give >500 exp?") in milliseconds from a local SQLite snapshot of TibiaWiki.

**Architecture:** A pinned upstream generator (`tibiawiki-sql`) produces a SQLite file at build time; the runtime is a stdio MCP server that reads that file through `node:sqlite` and never touches the network. One `createServer()` factory is bound to stdio in production and driven in-process by tests.

**Tech Stack:** TypeScript 7, Node ≥20 (developed on 24), `@modelcontextprotocol/server` 2.0.0, Zod 4, `node:sqlite` (stdlib), `node:test` (stdlib), pnpm 10 with supply-chain hardening.

**Spec:** `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Runtime makes no network calls.** Network access exists only in the `build-index` command. A network call anywhere under `src/tools/` or `src/db.ts` is a defect.
- **Node `>=20`**; `"type": "module"`; ESM output only.
- **Exact dependency pins** (pnpm `savePrefix: ''`): `@modelcontextprotocol/server@2.0.0`, `zod@4.6.1`, `typescript@7.0.2`, `@types/node@24.13.4`, `@modelcontextprotocol/client@2.0.0` (dev).
- **No test framework dependency.** Use `node:test` + `node:assert/strict`.
- **No SQLite driver dependency.** Use `node:sqlite` `DatabaseSync` with `{ readOnly: true }`.
- **Generator pinned to `tibiawiki-sql` 9.0.0**, always invoked with `--skip-images`.
- **Every tool** sets `annotations: { readOnlyHint: true }` and declares an `outputSchema`.
- **Every tool response** carries a `source` block: `{ page, url, indexGeneratedAt }`.
- **Attribution string** (verbatim, used in server instructions and README):
  `Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by CipSoft; game content and images are copyright CipSoft GmbH.`
- **DB path resolution**, one rule used by both indexer and server: `$TIBIAWIKI_MCP_DB`, else `${XDG_CACHE_HOME:-~/.cache}/tibiawiki-mcp/tibiawiki.db`.
- **Commit after every task** using conventional-commit prefixes. No AI attribution trailers.

## File Structure

| File | Responsibility |
|---|---|
| `src/index.ts` | bin entry; dispatches `serve` (default) vs `build-index` |
| `src/server.ts` | `createServer()` factory; registers all tools; owns server instructions |
| `src/db.ts` | DB path resolution, read-only open, schema probe, provenance |
| `src/domain.ts` | Single source of truth for element names, modifier mapping, verbosity |
| `src/cursor.ts` | Opaque pagination cursor encode/decode |
| `src/tools/get.ts` | `tibia_get` |
| `src/tools/search.ts` | `tibia_search` |
| `src/tools/find-creatures.ts` | `tibia_find_creatures` |
| `src/tools/find-items.ts` | `tibia_find_items` |
| `src/tools/how-to-obtain.ts` | `tibia_how_to_obtain` |
| `src/indexer/build-index.ts` | Runs pinned generator via Docker or uvx |
| `scripts/make-fixture.mjs` | Builds the committed test fixture from a full DB |
| `test/fixtures/tibiawiki-fixture.db` | Committed trimmed DB (not gitignored) |
| `test/*.test.ts` | Unit + in-process integration tests |

---

### Task 1: Project skeleton with hardened pnpm and a proven toolchain

**Why:** Nothing else can be verified until `tsc` and `node --test` demonstrably work together. This task's deliverable is a repo that builds and runs one trivial test.

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.json`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `pnpm build` → `dist/`; `pnpm test` runs `node --test`

- [ ] **Step 1: Create the hardened pnpm config**

`pnpm-workspace.yaml`:

```yaml
savePrefix: ''
minimumReleaseAge: 10080
trustPolicy: no-downgrade
blockExoticSubdeps: true
strictDepBuilds: true
allowBuilds: {}
verifyDepsBeforeRun: error
packageManagerStrictVersion: true
managePackageManagerVersions: true
```

`.npmrc`:

```
save-exact=true
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "tibiawiki-mcp",
  "version": "0.1.0",
  "description": "MCP server for TibiaWiki: offline attribute queries over creatures, items, NPCs, quests and spells",
  "type": "module",
  "license": "MIT",
  "mcpName": "io.github.jakubmucha/tibiawiki-mcp",
  "engines": { "node": ">=20" },
  "packageManager": "pnpm@10.33.0",
  "bin": { "tibiawiki-mcp": "dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "node --test dist/test/*.test.js",
    "pretest": "pnpm build"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "2.0.0",
    "zod": "4.6.1"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "2.0.0",
    "@types/node": "24.13.4",
    "typescript": "7.0.2"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

TypeScript 7 removed auto-inclusion of `@types/*`, so `types` must be explicit.

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "node20",
    "moduleResolution": "node20",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": false,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: Write the smoke test**

`test/smoke.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

test('toolchain: node:sqlite is available in the stdlib', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('create table t (x integer)');
  db.prepare('insert into t values (?)').run(42);
  assert.equal(db.prepare('select x from t').get()!.x, 42);
  db.close();
});
```

- [ ] **Step 5: Install and run**

```bash
pnpm install
pnpm test
```

Expected: install succeeds with a committed `pnpm-lock.yaml`; the smoke test passes.
If `typescript@7.0.2` or `@types/node@24.13.4` produce compile errors, drop to `typescript@5.9.3` + `@types/node@24.13.4` and record the change in this task's commit message. Do not proceed with a red build.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json test/smoke.test.ts
git commit -m "chore: scaffold project with hardened pnpm config and proven toolchain"
```

---

### Task 2: Database access layer and the test fixture

**Why:** Every tool depends on opening the DB and trusting its shape. Fail-fast validation belongs here, once. The fixture is folded in because the layer cannot be tested without it.

**Files:**
- Create: `src/db.ts`, `scripts/make-fixture.mjs`, `test/fixtures/tibiawiki-fixture.db`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `resolveDbPath(env?: NodeJS.ProcessEnv): string`
  - `openDb(path?: string): TibiaDb`
  - `type TibiaDb = { db: DatabaseSync; provenance: Provenance; close(): void }`
  - `type Provenance = { version: string; generatedAt: string }`
  - `class SchemaError extends Error`

- [ ] **Step 1: Write the fixture builder**

`scripts/make-fixture.mjs` — run once against a full DB to produce the committed fixture. Keeps the fixture reproducible rather than an opaque binary.

```js
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, rmSync } from 'node:fs';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) throw new Error('usage: make-fixture.mjs <full.db> <fixture.db>');
rmSync(dest, { force: true });
copyFileSync(src, dest);

const db = new DatabaseSync(dest);
// Keep a small, connected slice: named creatures plus everything reachable from them.
const KEEP = ['Dragon', 'Dragon Lord', 'Rotworm', 'Demon', 'Cyclops'];
const list = KEEP.map((n) => `'${n}'`).join(',');
db.exec(`delete from creature where name not in (${list})`);
db.exec('delete from creature_drop where creature_id not in (select article_id from creature)');
db.exec('delete from item where article_id not in (select item_id from creature_drop) and name not in (\'Magic Longsword\',\'Steel Helmet\')');
db.exec('delete from npc_offer_buy where item_id not in (select article_id from item)');
db.exec('delete from npc_offer_sell where item_id not in (select article_id from item)');
db.exec('delete from npc where article_id not in (select npc_id from npc_offer_buy union select npc_id from npc_offer_sell)');
db.exec('delete from item_attribute where item_id not in (select article_id from item)');
db.exec('vacuum');
db.close();
console.log('fixture written:', dest);
```

- [ ] **Step 2: Generate the fixture**

```bash
node scripts/make-fixture.mjs data/tibiawiki.db test/fixtures/tibiawiki-fixture.db
```

Expected: prints `fixture written:` and the file is under 1 MB.

- [ ] **Step 3: Write the failing test**

`test/db.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDbPath, openDb, SchemaError } from '../src/db.ts';

const FIXTURE = new URL('./fixtures/tibiawiki-fixture.db', import.meta.url).pathname;

test('resolveDbPath prefers the explicit env override', () => {
  assert.equal(resolveDbPath({ TIBIAWIKI_MCP_DB: '/tmp/x.db' } as NodeJS.ProcessEnv), '/tmp/x.db');
});

test('resolveDbPath falls back to the cache directory', () => {
  const p = resolveDbPath({ HOME: '/home/u' } as NodeJS.ProcessEnv);
  assert.equal(p, '/home/u/.cache/tibiawiki-mcp/tibiawiki.db');
});

test('openDb exposes provenance from database_info', () => {
  const h = openDb(FIXTURE);
  assert.equal(h.provenance.version, '9.0.0');
  assert.match(h.provenance.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  h.close();
});

test('openDb throws a clear error when the file is missing', () => {
  assert.throws(() => openDb('/nonexistent/tibiawiki.db'), /build-index/);
});

test('openDb reports the exact missing column when the schema has drifted', () => {
  // Build a DB that satisfies nothing, to prove the probe names what it wants.
  const bad = join(mkdtempSync(join(tmpdir(), 'twmcp-')), 'bad.db');
  const db = new DatabaseSync(bad);
  db.exec('create table creature (article_id integer)');
  db.close();
  assert.throws(() => openDb(bad), (e: unknown) => {
    assert.ok(e instanceof SchemaError);
    assert.match((e as Error).message, /hitpoints|missing required/);
    return true;
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../src/db.ts'`.

- [ ] **Step 5: Implement `src/db.ts`**

```ts
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type Provenance = { version: string; generatedAt: string };
export type TibiaDb = { db: DatabaseSync; provenance: Provenance; close(): void };

export class SchemaError extends Error {}

/** Required shape. Probed at startup so a schema drift names its column instead of returning nulls. */
const REQUIRED: Record<string, string[]> = {
  creature: ['article_id', 'name', 'hitpoints', 'experience', 'modifier_fire', 'is_boss'],
  item: ['article_id', 'name', 'item_class'],
  creature_drop: ['creature_id', 'item_id', 'chance', 'min', 'max'],
  npc: ['article_id', 'name', 'city'],
  npc_offer_sell: ['npc_id', 'item_id', 'value'],
  database_info: ['key', 'value'],
};

export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TIBIAWIKI_MCP_DB) return env.TIBIAWIKI_MCP_DB;
  const cache = env.XDG_CACHE_HOME ?? join(env.HOME ?? '', '.cache');
  return join(cache, 'tibiawiki-mcp', 'tibiawiki.db');
}

export function openDb(path: string = resolveDbPath()): TibiaDb {
  if (!existsSync(path)) {
    throw new Error(
      `TibiaWiki index not found at ${path}. Run \`tibiawiki-mcp build-index\` to create it.`,
    );
  }
  const db = new DatabaseSync(path, { readOnly: true });
  assertSchema(db);
  return { db, provenance: readProvenance(db), close: () => db.close() };
}

function assertSchema(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(REQUIRED)) {
    const present = new Set(
      db.prepare(`pragma table_info(${table})`).all().map((r) => String(r.name)),
    );
    if (present.size === 0) throw new SchemaError(`Index is missing required table: ${table}`);
    for (const c of columns) {
      if (!present.has(c)) {
        throw new SchemaError(
          `Index table "${table}" is missing required column "${c}". ` +
            `The index was likely built by a different tibiawiki-sql version; rebuild with build-index.`,
        );
      }
    }
  }
}

function readProvenance(db: DatabaseSync): Provenance {
  const rows = db.prepare('select key, value from database_info').all();
  const map = new Map(rows.map((r) => [String(r.key), String(r.value)]));
  return { version: map.get('version') ?? 'unknown', generatedAt: map.get('generate_time') ?? 'unknown' };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 5 tests in `db.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts scripts/make-fixture.mjs test/fixtures/tibiawiki-fixture.db test/db.test.ts
git commit -m "feat: add read-only database layer with fail-fast schema probe"
```

---

### Task 3: Domain policy and pagination primitives

**Why:** The "weak to fire means `modifier_fire > 100`" rule is business policy. It must exist in exactly one place so the model never has to know the convention and no tool can drift from it.

**Files:**
- Create: `src/domain.ts`, `src/cursor.ts`
- Test: `test/domain.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `const ELEMENTS: readonly Element[]`
  - `type Element = 'physical'|'earth'|'fire'|'ice'|'energy'|'death'|'holy'|'drown'|'lifedrain'|'healing'`
  - `modifierColumn(e: Element): string`
  - `const elementSchema: z.ZodEnum` — reused by every tool's `inputSchema`
  - `encodeCursor(offset: number): string` / `decodeCursor(c: string | undefined): number`

- [ ] **Step 1: Write the failing test**

`test/domain.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELEMENTS, modifierColumn } from '../src/domain.ts';
import { encodeCursor, decodeCursor } from '../src/cursor.ts';

test('every element maps to a real modifier column', () => {
  assert.equal(ELEMENTS.length, 10);
  assert.equal(modifierColumn('fire'), 'modifier_fire');
  assert.equal(modifierColumn('lifedrain'), 'modifier_lifedrain');
});

test('modifierColumn rejects an unknown element rather than building bad SQL', () => {
  assert.throws(() => modifierColumn('lava' as never), /unknown element/i);
});

test('cursor round-trips and rejects garbage', () => {
  assert.equal(decodeCursor(encodeCursor(120)), 120);
  assert.equal(decodeCursor(undefined), 0);
  assert.throws(() => decodeCursor('not-a-cursor'), /cursor/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find `../src/domain.ts`.

- [ ] **Step 3: Implement `src/domain.ts`**

```ts
import { z } from 'zod';

export const ELEMENTS = [
  'physical', 'earth', 'fire', 'ice', 'energy',
  'death', 'holy', 'drown', 'lifedrain', 'healing',
] as const;

export type Element = (typeof ELEMENTS)[number];

export const elementSchema = z.enum(ELEMENTS);

/**
 * Maps an element to its column. Whitelist-only: the returned string is
 * interpolated into SQL, so an unknown element must throw rather than pass through.
 */
export function modifierColumn(element: Element): string {
  if (!ELEMENTS.includes(element)) throw new Error(`Unknown element: ${String(element)}`);
  return `modifier_${element}`;
}

/**
 * Damage modifiers are percentages: 100 is neutral, above 100 takes extra damage.
 * Encoding this once keeps the convention out of every caller.
 */
export const WEAK_TO = (column: string) => `${column} > 100`;
export const RESISTANT_TO = (column: string) => `${column} < 100`;

export const verbositySchema = z.enum(['concise', 'detailed']).default('concise');

/** Long prose omitted at concise verbosity to keep responses cheap. */
export const PROSE_FIELDS = ['history', 'notes', 'bestiary_text', 'behaviour', 'strategy'] as const;
```

- [ ] **Step 4: Implement `src/cursor.ts`**

```ts
/** Opaque offset cursor. Opaque so the shape can change without breaking clients. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^o:(\d+)$/.exec(raw);
  if (!m) throw new Error(`Invalid cursor: ${cursor}`);
  return Number(m[1]);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain.ts src/cursor.ts test/domain.test.ts
git commit -m "feat: add element modifier policy and opaque pagination cursors"
```

---

### Task 4: Server factory, `tibia_get`, and the stdio entry point

**Why:** The first end-to-end slice. It proves the factory, tool registration, the in-process test harness, and the stdio binding all work together before four more tools are layered on.

**Files:**
- Create: `src/server.ts`, `src/tools/get.ts`, `src/index.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `openDb`, `TibiaDb`, `Provenance` (Task 2); `PROSE_FIELDS`, `verbositySchema` (Task 3)
- Produces:
  - `createServer(handle: TibiaDb): McpServer`
  - `sourceBlock(page: string, p: Provenance): { page: string; url: string; indexGeneratedAt: string }`
  - `registerGet(server: McpServer, handle: TibiaDb): void`

- [ ] **Step 1: Write the failing test**

`test/server.test.ts` — drives a real MCP client against the handler in-process. No subprocess, no port.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDb } from '../src/db.ts';
import { createServer } from '../src/server.ts';

const FIXTURE = new URL('./fixtures/tibiawiki-fixture.db', import.meta.url).pathname;

async function connect() {
  const handle = openDb(FIXTURE);
  const handler = createMcpHandler(() => createServer(handle));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url: string | URL, init?: RequestInit) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'test-harness', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    async close() { await client.close(); await handler.close(); handle.close(); },
  };
}

test('tools/list advertises tibia_get as read-only', async () => {
  const h = await connect();
  const { tools } = await h.client.listTools();
  const get = tools.find((t) => t.name === 'tibia_get');
  assert.ok(get, 'tibia_get should be registered');
  assert.equal(get!.annotations?.readOnlyHint, true);
  await h.close();
});

test('tibia_get returns known-good structured data for Dragon', async () => {
  const h = await connect();
  const res = await h.client.callTool({ name: 'tibia_get', arguments: { name: 'Dragon' } });
  const data = res.structuredContent as any;
  assert.equal(data.name, 'Dragon');
  assert.equal(data.hitpoints, 1000);
  assert.equal(data.experience, 700);
  assert.equal(data.modifiers.fire, 0);
  assert.equal(data.source.url, 'https://tibia.fandom.com/wiki/Dragon');
  await h.close();
});

test('tibia_get reports an unknown name as a model-recoverable error', async () => {
  const h = await connect();
  const res = await h.client.callTool({ name: 'tibia_get', arguments: { name: 'Nonexistent Beast' } });
  assert.equal(res.isError, true);
  await h.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find `../src/server.ts`.

- [ ] **Step 3: Implement `src/tools/get.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb, Provenance } from '../db.ts';
import { ELEMENTS, PROSE_FIELDS, verbositySchema } from '../domain.ts';

export function sourceBlock(page: string, p: Provenance) {
  return {
    page,
    url: `https://tibia.fandom.com/wiki/${encodeURIComponent(page.replace(/ /g, '_'))}`,
    indexGeneratedAt: p.generatedAt,
  };
}

const outputSchema = z.object({
  name: z.string(),
  type: z.string(),
  hitpoints: z.number().nullable(),
  experience: z.number().nullable(),
  armor: z.number().nullable(),
  speed: z.number().nullable(),
  bestiaryClass: z.string().nullable(),
  modifiers: z.record(z.string(), z.number().nullable()),
  loot: z.array(z.object({
    item: z.string(),
    chance: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
  })),
  prose: z.record(z.string(), z.string()).optional(),
  source: z.object({ page: z.string(), url: z.string(), indexGeneratedAt: z.string() }),
});

export function registerGet(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  const creature = db.prepare('select * from creature where name = ? collate nocase');
  const drops = db.prepare(`
    select i.name as item, d.chance, d.min, d.max
    from creature_drop d
    join item i on i.article_id = d.item_id
    where d.creature_id = ?
    order by (d.chance is null), d.chance asc`);

  server.registerTool(
    'tibia_get',
    {
      description:
        'Full detail for one named Tibia creature by its exact wiki page name, including its full loot table with drop chances. ' +
        'Use tibia_search first if the exact name is not known.',
      inputSchema: z.object({
        name: z.string().describe('Exact wiki page name, e.g. "Dragon Lord".'),
        verbosity: verbositySchema.describe('"detailed" additionally returns long prose fields.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name, verbosity }) => {
      const row = creature.get(name) as Record<string, unknown> | undefined;
      if (!row) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `No creature named "${name}" in the index. Try tibia_search to find the exact page name.`,
          }],
        };
      }

      const modifiers = Object.fromEntries(
        ELEMENTS.map((e) => [e, (row[`modifier_${e}`] as number | null) ?? null]),
      );

      const output = {
        name: String(row.name),
        type: 'creature',
        hitpoints: (row.hitpoints as number | null) ?? null,
        experience: (row.experience as number | null) ?? null,
        armor: (row.armor as number | null) ?? null,
        speed: (row.speed as number | null) ?? null,
        bestiaryClass: (row.bestiary_class as string | null) ?? null,
        modifiers,
        loot: drops.all(row.article_id as number).map((d) => ({
          item: String(d.item),
          chance: (d.chance as number | null) ?? null,
          min: (d.min as number | null) ?? null,
          max: (d.max as number | null) ?? null,
        })),
        ...(verbosity === 'detailed'
          ? {
              prose: Object.fromEntries(
                PROSE_FIELDS.filter((f) => row[f]).map((f) => [f, String(row[f])]),
              ),
            }
          : {}),
        source: sourceBlock(String(row.title ?? row.name), provenance),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
```

- [ ] **Step 4: Implement `src/server.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from './db.ts';
import { registerGet } from './tools/get.ts';

export const ATTRIBUTION =
  'Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. ' +
  'Tibia is made by CipSoft; game content and images are copyright CipSoft GmbH.';

export function createServer(handle: TibiaDb): McpServer {
  const server = new McpServer(
    { name: 'tibiawiki-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        `Offline TibiaWiki knowledge base. Index generated ${handle.provenance.generatedAt} ` +
        `by tibiawiki-sql ${handle.provenance.version}; it reflects the wiki as of that time, not live game state. ` +
        ATTRIBUTION,
    },
  );
  registerGet(server, handle);
  return server;
}
```

- [ ] **Step 5: Implement `src/index.ts`**

```ts
#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { openDb } from './db.ts';
import { createServer } from './server.ts';

const command = process.argv[2] ?? 'serve';

if (command === 'build-index') {
  const { buildIndex } = await import('./indexer/build-index.ts');
  await buildIndex();
} else if (command === 'serve') {
  // Open once and share across the connection: the DB is read-only and immutable.
  const handle = openDb();
  serveStdio(() => createServer(handle));
} else {
  process.stderr.write(`Unknown command: ${command}\nUsage: tibiawiki-mcp [serve|build-index]\n`);
  process.exit(2);
}
```

Note: Task 9 creates `src/indexer/build-index.ts`. Until then `build-index` fails at import; `serve` works. That is acceptable because the dynamic import keeps `serve` independent of it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 3 tests in `server.test.ts`, including the Dragon known-answer case.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/tools/get.ts src/index.ts test/server.test.ts
git commit -m "feat: add server factory, tibia_get tool and stdio entry point"
```

---

### Task 5: `tibia_search`

**Why:** The model rarely knows exact page names. Without this, `tibia_get` is a guessing game.

**Files:**
- Create: `src/tools/search.ts`
- Modify: `src/server.ts` (register the tool)
- Test: `test/search.test.ts`

**Interfaces:**
- Consumes: `TibiaDb`, `sourceBlock`, `encodeCursor`/`decodeCursor`
- Produces: `registerSearch(server: McpServer, handle: TibiaDb): void`

- [ ] **Step 1: Write the failing test**

`test/search.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';

test('tibia_search finds a creature by partial name', async () => {
  const h = await connect();
  const res = await h.client.callTool({ name: 'tibia_search', arguments: { query: 'drag' } });
  const data = res.structuredContent as any;
  const names = data.results.map((r: any) => r.name);
  assert.ok(names.includes('Dragon'), `expected Dragon in ${JSON.stringify(names)}`);
  assert.ok(data.results.every((r: any) => typeof r.type === 'string'));
  await h.close();
});

test('tibia_search can be restricted by type', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_search',
    arguments: { query: 'a', types: ['item'] },
  });
  const data = res.structuredContent as any;
  assert.ok(data.results.every((r: any) => r.type === 'item'));
  await h.close();
});
```

- [ ] **Step 2: Extract the shared test harness**

`test/harness.ts` — Task 4's `connect()` moved here so every tool test reuses one harness instead of copying it.

```ts
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDb } from '../src/db.ts';
import { createServer } from '../src/server.ts';

const FIXTURE = new URL('./fixtures/tibiawiki-fixture.db', import.meta.url).pathname;

export async function connect() {
  const handle = openDb(FIXTURE);
  const handler = createMcpHandler(() => createServer(handle));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url: string | URL, init?: RequestInit) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'test-harness', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    async close() { await client.close(); await handler.close(); handle.close(); },
  };
}
```

Then replace the inline `connect()` in `test/server.test.ts` with `import { connect } from './harness.ts';`.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — `tibia_search` is not a registered tool.

- [ ] **Step 4: Implement `src/tools/search.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from '../db.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

const SEARCHABLE = ['creature', 'item', 'npc', 'quest', 'spell'] as const;
type Searchable = (typeof SEARCHABLE)[number];

const outputSchema = z.object({
  results: z.array(z.object({ name: z.string(), type: z.string() })),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export function registerSearch(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;
  // One prepared statement per table; the table name is never interpolated from user input.
  const stmts = new Map<Searchable, ReturnType<typeof db.prepare>>(
    SEARCHABLE.map((t) => [t, db.prepare(`select name from ${t} where name like ? collate nocase order by length(name), name`)]),
  );

  server.registerTool(
    'tibia_search',
    {
      description:
        'Find Tibia pages whose name matches a substring, across creatures, items, NPCs, quests and spells. ' +
        'Use this to resolve an approximate name into the exact page name that tibia_get expects.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Substring to match against page names, case-insensitive.'),
        types: z.array(z.enum(SEARCHABLE)).optional().describe('Restrict to these entity types. Defaults to all.'),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, types, limit, cursor }) => {
      const offset = decodeCursor(cursor);
      const wanted = types ?? [...SEARCHABLE];
      const pattern = `%${query}%`;

      const all: { name: string; type: string }[] = [];
      for (const t of wanted) {
        for (const row of stmts.get(t)!.all(pattern)) {
          all.push({ name: String(row.name), type: t });
        }
      }
      all.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));

      const page = all.slice(offset, offset + limit);
      const output = {
        results: page,
        ...(offset + limit < all.length ? { nextCursor: encodeCursor(offset + limit) } : {}),
        indexGeneratedAt: provenance.generatedAt,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
        ttlMs: 3_600_000,
        cacheScope: 'public' as const,
      };
    },
  );
}
```

- [ ] **Step 5: Register it in `src/server.ts`**

Add the import and the call:

```ts
import { registerSearch } from './tools/search.ts';
// ...inside createServer, after registerGet(server, handle):
  registerSearch(server, handle);
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm test`
Expected: PASS — search tests plus all earlier tests still green.

- [ ] **Step 7: Commit**

```bash
git add src/tools/search.ts src/server.ts test/search.test.ts test/harness.ts test/server.test.ts
git commit -m "feat: add tibia_search tool with shared in-process test harness"
```

---

### Task 6: `tibia_find_creatures`

**Why:** This is the headline capability — the attribute query no upstream source can answer.

**Files:**
- Create: `src/tools/find-creatures.ts`
- Modify: `src/server.ts`
- Test: `test/find-creatures.test.ts`

**Interfaces:**
- Consumes: `modifierColumn`, `WEAK_TO`, `RESISTANT_TO`, `elementSchema`, cursor helpers
- Produces: `registerFindCreatures(server: McpServer, handle: TibiaDb): void`

- [ ] **Step 1: Write the failing test**

`test/find-creatures.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';

test('finds creatures weak to a given element above an experience floor', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures',
    arguments: { weak_to: ['fire'], experience_min: 100 },
  });
  const data = res.structuredContent as any;
  assert.ok(data.results.length > 0, 'expected at least one match in the fixture');
  for (const r of data.results) {
    assert.ok(r.modifiers.fire > 100, `${r.name} should take extra fire damage`);
    assert.ok(r.experience >= 100);
  }
  await h.close();
});

test('Dragon is excluded when searching for fire weakness (it is fire-immune)', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures',
    arguments: { weak_to: ['fire'] },
  });
  const names = (res.structuredContent as any).results.map((r: any) => r.name);
  assert.ok(!names.includes('Dragon'), 'Dragon has modifier_fire = 0 and must not match');
  await h.close();
});

test('paginates with an opaque cursor', async () => {
  const h = await connect();
  const first = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { limit: 1 },
  });
  const d1 = first.structuredContent as any;
  assert.equal(d1.results.length, 1);
  assert.ok(d1.nextCursor, 'expected a nextCursor');
  const second = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { limit: 1, cursor: d1.nextCursor },
  });
  const d2 = second.structuredContent as any;
  assert.notEqual(d1.results[0].name, d2.results[0].name);
  await h.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — `tibia_find_creatures` is not registered.

- [ ] **Step 3: Implement `src/tools/find-creatures.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from '../db.ts';
import { ELEMENTS, elementSchema, modifierColumn, WEAK_TO, RESISTANT_TO } from '../domain.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

const SORTS = { experience: 'experience', hitpoints: 'hitpoints', name: 'name' } as const;

const outputSchema = z.object({
  results: z.array(z.object({
    name: z.string(),
    hitpoints: z.number().nullable(),
    experience: z.number().nullable(),
    bestiaryClass: z.string().nullable(),
    modifiers: z.record(z.string(), z.number().nullable()),
  })),
  totalMatches: z.number(),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export function registerFindCreatures(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  server.registerTool(
    'tibia_find_creatures',
    {
      description:
        'Find Tibia creatures matching stat filters. Damage modifiers are percentages where 100 is neutral: ' +
        '"weak_to" means the creature takes MORE than 100% damage from that element, "resistant_to" means less. ' +
        'Use this for questions like "which creatures are weak to fire and give over 500 experience".',
      inputSchema: z.object({
        weak_to: z.array(elementSchema).optional(),
        resistant_to: z.array(elementSchema).optional(),
        experience_min: z.number().int().optional(),
        experience_max: z.number().int().optional(),
        hitpoints_min: z.number().int().optional(),
        hitpoints_max: z.number().int().optional(),
        bestiary_class: z.string().optional(),
        is_boss: z.boolean().optional(),
        location_contains: z.string().optional(),
        sort: z.enum(['experience', 'hitpoints', 'name']).default('experience'),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const where: string[] = [];
      const params: (string | number)[] = [];

      for (const e of args.weak_to ?? []) where.push(WEAK_TO(modifierColumn(e)));
      for (const e of args.resistant_to ?? []) where.push(RESISTANT_TO(modifierColumn(e)));
      if (args.experience_min !== undefined) { where.push('experience >= ?'); params.push(args.experience_min); }
      if (args.experience_max !== undefined) { where.push('experience <= ?'); params.push(args.experience_max); }
      if (args.hitpoints_min !== undefined) { where.push('hitpoints >= ?'); params.push(args.hitpoints_min); }
      if (args.hitpoints_max !== undefined) { where.push('hitpoints <= ?'); params.push(args.hitpoints_max); }
      if (args.bestiary_class !== undefined) { where.push('bestiary_class = ? collate nocase'); params.push(args.bestiary_class); }
      if (args.is_boss !== undefined) { where.push('is_boss = ?'); params.push(args.is_boss ? 1 : 0); }
      if (args.location_contains !== undefined) { where.push('location like ? collate nocase'); params.push(`%${args.location_contains}%`); }

      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const orderCol = SORTS[args.sort];
      const direction = args.sort === 'name' ? 'asc' : 'desc';
      const offset = decodeCursor(args.cursor);

      const total = db.prepare(`select count(*) as c from creature ${clause}`).get(...params) as { c: number };
      const rows = db
        .prepare(`select * from creature ${clause} order by (${orderCol} is null), ${orderCol} ${direction}, name asc limit ? offset ?`)
        .all(...params, args.limit, offset);

      const output = {
        results: rows.map((row) => ({
          name: String(row.name),
          hitpoints: (row.hitpoints as number | null) ?? null,
          experience: (row.experience as number | null) ?? null,
          bestiaryClass: (row.bestiary_class as string | null) ?? null,
          modifiers: Object.fromEntries(
            ELEMENTS.map((e) => [e, (row[`modifier_${e}`] as number | null) ?? null]),
          ),
        })),
        totalMatches: total.c,
        ...(offset + args.limit < total.c ? { nextCursor: encodeCursor(offset + args.limit) } : {}),
        indexGeneratedAt: provenance.generatedAt,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
        ttlMs: 3_600_000,
        cacheScope: 'public' as const,
      };
    },
  );
}
```

- [ ] **Step 4: Register in `src/server.ts`**

```ts
import { registerFindCreatures } from './tools/find-creatures.ts';
// inside createServer:
  registerFindCreatures(server, handle);
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test`
Expected: PASS — including the Dragon-is-fire-immune exclusion case.

- [ ] **Step 6: Commit**

```bash
git add src/tools/find-creatures.ts src/server.ts test/find-creatures.test.ts
git commit -m "feat: add tibia_find_creatures attribute query tool"
```

---

### Task 7: `tibia_find_items`

**Why:** The item equivalent of Task 6. It is a separate task because item stats are stored differently and the SQL is genuinely different work.

**Schema note (verified 2026-09-10):** Unlike `creature`, item stats are **not columns**. `item` carries only `item_class`, `item_type`, `type_secondary`, `weight`, `value_buy`, `value_sell`, `is_marketable`. Everything else — `attack`, `defense`, `armor`, `required_level`, `required_vocation`, `weapon_type`, `hands` — lives in `item_attribute(item_id, name, value)` as **TEXT** rows. Numeric comparisons therefore require `cast(value as integer)`.

**Files:**
- Create: `src/tools/find-items.ts`
- Modify: `src/server.ts`
- Test: `test/find-items.test.ts`

**Interfaces:**
- Consumes: `TibiaDb`, cursor helpers
- Produces: `registerFindItems(server: McpServer, handle: TibiaDb): void`

- [ ] **Step 1: Write the failing test**

`test/find-items.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';

test('filters items by a numeric EAV attribute', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_items',
    arguments: { attack_min: 50 },
  });
  const data = res.structuredContent as any;
  assert.ok(data.results.length > 0);
  for (const r of data.results) assert.ok(r.attributes.attack >= 50);
  await h.close();
});

test('Magic Longsword is found by its exact known attributes', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_items',
    arguments: { attack_min: 55, attack_max: 55, required_level_max: 140 },
  });
  const names = (res.structuredContent as any).results.map((r: any) => r.name);
  assert.ok(names.includes('Magic Longsword'), `got ${JSON.stringify(names)}`);
  await h.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — `tibia_find_items` is not registered.

- [ ] **Step 3: Implement `src/tools/find-items.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from '../db.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

/** Numeric attributes stored as TEXT in item_attribute; compared with a cast. */
const NUMERIC_ATTRS = ['attack', 'defense', 'armor', 'required_level', 'imbuement_slots'] as const;
/** Reported for every returned item so the model sees why it matched. */
const REPORTED_ATTRS = [...NUMERIC_ATTRS, 'required_vocation', 'weapon_type', 'hands'] as const;

const outputSchema = z.object({
  results: z.array(z.object({
    name: z.string(),
    itemClass: z.string().nullable(),
    itemType: z.string().nullable(),
    weight: z.number().nullable(),
    valueBuy: z.number().nullable(),
    attributes: z.record(z.string(), z.union([z.number(), z.string()])),
  })),
  totalMatches: z.number(),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export function registerFindItems(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;
  const attrs = db.prepare('select name, value from item_attribute where item_id = ?');

  server.registerTool(
    'tibia_find_items',
    {
      description:
        'Find Tibia items matching class, type and stat filters such as attack, defense, armor and required level. ' +
        'Use this for questions like "which two-handed swords need level 100 or less".',
      inputSchema: z.object({
        item_class: z.string().optional().describe('e.g. "Weapons", "Armors".'),
        item_type: z.string().optional().describe('e.g. "Sword Weapons".'),
        weapon_type: z.string().optional().describe('e.g. "Sword", "Axe", "Club".'),
        vocation: z.string().optional().describe('Matches required_vocation, e.g. "knights".'),
        attack_min: z.number().int().optional(),
        attack_max: z.number().int().optional(),
        defense_min: z.number().int().optional(),
        armor_min: z.number().int().optional(),
        required_level_max: z.number().int().optional(),
        sort: z.enum(['name', 'weight', 'value']).default('name'),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const where: string[] = [];
      const params: (string | number)[] = [];

      const numericFilter = (attr: string, op: '>=' | '<=', value: number) => {
        where.push(
          `exists (select 1 from item_attribute a where a.item_id = item.article_id and a.name = ? and cast(a.value as integer) ${op} ?)`,
        );
        params.push(attr, value);
      };
      const textFilter = (attr: string, value: string) => {
        where.push(
          'exists (select 1 from item_attribute a where a.item_id = item.article_id and a.name = ? and a.value like ? collate nocase)',
        );
        params.push(attr, `%${value}%`);
      };

      if (args.item_class !== undefined) { where.push('item_class = ? collate nocase'); params.push(args.item_class); }
      if (args.item_type !== undefined) { where.push('item_type = ? collate nocase'); params.push(args.item_type); }
      if (args.attack_min !== undefined) numericFilter('attack', '>=', args.attack_min);
      if (args.attack_max !== undefined) numericFilter('attack', '<=', args.attack_max);
      if (args.defense_min !== undefined) numericFilter('defense', '>=', args.defense_min);
      if (args.armor_min !== undefined) numericFilter('armor', '>=', args.armor_min);
      if (args.required_level_max !== undefined) numericFilter('required_level', '<=', args.required_level_max);
      if (args.weapon_type !== undefined) textFilter('weapon_type', args.weapon_type);
      if (args.vocation !== undefined) textFilter('required_vocation', args.vocation);

      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const order = { name: 'name asc', weight: 'weight asc', value: 'value_buy desc' }[args.sort];
      const offset = decodeCursor(args.cursor);

      const total = db.prepare(`select count(*) as c from item ${clause}`).get(...params) as { c: number };
      const rows = db
        .prepare(`select * from item ${clause} order by ${order}, name asc limit ? offset ?`)
        .all(...params, args.limit, offset);

      const output = {
        results: rows.map((row) => {
          const bag: Record<string, number | string> = {};
          for (const a of attrs.all(row.article_id as number)) {
            const key = String(a.name);
            if (!REPORTED_ATTRS.includes(key as never)) continue;
            bag[key] = NUMERIC_ATTRS.includes(key as never) ? Number(a.value) : String(a.value);
          }
          return {
            name: String(row.name),
            itemClass: (row.item_class as string | null) ?? null,
            itemType: (row.item_type as string | null) ?? null,
            weight: (row.weight as number | null) ?? null,
            valueBuy: (row.value_buy as number | null) ?? null,
            attributes: bag,
          };
        }),
        totalMatches: total.c,
        ...(offset + args.limit < total.c ? { nextCursor: encodeCursor(offset + args.limit) } : {}),
        indexGeneratedAt: provenance.generatedAt,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
        ttlMs: 3_600_000,
        cacheScope: 'public' as const,
      };
    },
  );
}
```

- [ ] **Step 4: Register in `src/server.ts`**

```ts
import { registerFindItems } from './tools/find-items.ts';
// inside createServer:
  registerFindItems(server, handle);
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/find-items.ts src/server.ts test/find-items.test.ts
git commit -m "feat: add tibia_find_items tool over EAV item attributes"
```

---

### Task 8: `tibia_how_to_obtain`

**Why:** "Where do I get X?" is one user question spanning three tables. Consolidating it into one tool means the model makes one call instead of three and cannot mis-join them.

**Naming trap (verified 2026-09-10):** `npc_offer_sell` is the NPC **selling to the player** (Steel Helmet: 580 gold). `npc_offer_buy` is the NPC **buying from the player** (293 gold). Obtaining an item therefore reads `npc_offer_sell`. The `currency_id` column joins back to `item` for the currency name.

**Files:**
- Create: `src/tools/how-to-obtain.ts`
- Modify: `src/server.ts`, `src/db.ts` (add `quest_reward` and `npc_offer_buy` to `REQUIRED`)
- Test: `test/how-to-obtain.test.ts`

**Interfaces:**
- Consumes: `TibiaDb`, `sourceBlock`
- Produces: `registerHowToObtain(server: McpServer, handle: TibiaDb): void`

- [ ] **Step 1: Write the failing test**

`test/how-to-obtain.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';

test('reports creature drops with chances', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Dragon Shield' },
  });
  const data = res.structuredContent as any;
  assert.ok(data.droppedBy.some((d: any) => d.creature === 'Dragon'));
  await h.close();
});

test('reports NPC vendors at the price the player pays', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Steel Helmet' },
  });
  const data = res.structuredContent as any;
  assert.ok(data.soldByNpcs.length > 0);
  assert.ok(data.soldByNpcs.every((v: any) => v.price >= 580),
    'must use npc_offer_sell (player buys), not npc_offer_buy');
  await h.close();
});

test('an item with no source returns empty lists, not an error', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Magic Longsword' },
  });
  const data = res.structuredContent as any;
  assert.equal(res.isError, undefined);
  assert.deepEqual(data.droppedBy, []);
  assert.ok(data.note.length > 0, 'should explain that the item has no in-game source');
  await h.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — `tibia_how_to_obtain` is not registered.

- [ ] **Step 3: Implement `src/tools/how-to-obtain.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from '../db.ts';
import { sourceBlock } from './get.ts';

const outputSchema = z.object({
  item: z.string(),
  droppedBy: z.array(z.object({
    creature: z.string(),
    chance: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
  })),
  soldByNpcs: z.array(z.object({
    npc: z.string(), city: z.string().nullable(), price: z.number(), currency: z.string(),
  })),
  questRewards: z.array(z.string()),
  note: z.string(),
  source: z.object({ page: z.string(), url: z.string(), indexGeneratedAt: z.string() }),
});

export function registerHowToObtain(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  const findItem = db.prepare('select article_id, name, title from item where name = ? collate nocase');
  const dropped = db.prepare(`
    select c.name as creature, d.chance, d.min, d.max
    from creature_drop d join creature c on c.article_id = d.creature_id
    where d.item_id = ? order by (d.chance is null), d.chance desc`);
  // npc_offer_sell = the NPC sells it to the player. This is the obtaining direction.
  const vendors = db.prepare(`
    select n.name as npc, n.city, o.value as price, coalesce(cur.name, 'Gold Coin') as currency
    from npc_offer_sell o
    join npc n on n.article_id = o.npc_id
    left join item cur on cur.article_id = o.currency_id
    where o.item_id = ? order by o.value asc`);
  const quests = db.prepare(`
    select q.name from quest_reward r join quest q on q.article_id = r.quest_id where r.item_id = ?`);

  server.registerTool(
    'tibia_how_to_obtain',
    {
      description:
        'Every in-game source for one item: which creatures drop it (with drop chance), which NPCs sell it ' +
        '(at the price the player pays), and which quests reward it. Prefer this over three separate lookups.',
      inputSchema: z.object({
        item_name: z.string().describe('Exact item page name, e.g. "Dragon Shield".'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ item_name }) => {
      const item = findItem.get(item_name) as Record<string, unknown> | undefined;
      if (!item) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `No item named "${item_name}" in the index. Use tibia_search with types: ["item"] to find the exact name.`,
          }],
        };
      }
      const id = item.article_id as number;
      const droppedBy = dropped.all(id).map((r) => ({
        creature: String(r.creature),
        chance: (r.chance as number | null) ?? null,
        min: (r.min as number | null) ?? null,
        max: (r.max as number | null) ?? null,
      }));
      const soldByNpcs = vendors.all(id).map((r) => ({
        npc: String(r.npc),
        city: (r.city as string | null) ?? null,
        price: Number(r.price),
        currency: String(r.currency),
      }));
      const questRewards = quests.all(id).map((r) => String(r.name));

      const none = droppedBy.length === 0 && soldByNpcs.length === 0 && questRewards.length === 0;
      const output = {
        item: String(item.name),
        droppedBy,
        soldByNpcs,
        questRewards,
        note: none
          ? 'No creature drop, NPC vendor or quest reward is recorded for this item. Some items are unobtainable, event-only, or were removed from the game.'
          : '',
        source: sourceBlock(String(item.title ?? item.name), provenance),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
        ttlMs: 3_600_000,
        cacheScope: 'public' as const,
      };
    },
  );
}
```

- [ ] **Step 4: Extend the schema probe in `src/db.ts`**

Add to `REQUIRED`:

```ts
  npc_offer_buy: ['npc_id', 'item_id', 'value', 'currency_id'],
  quest_reward: ['quest_id', 'item_id'],
  quest: ['article_id', 'name'],
```

and extend the existing `npc_offer_sell` entry to `['npc_id', 'item_id', 'value', 'currency_id']`.

- [ ] **Step 5: Register in `src/server.ts`**

```ts
import { registerHowToObtain } from './tools/how-to-obtain.ts';
// inside createServer:
  registerHowToObtain(server, handle);
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm test`
Expected: PASS — all three cases, including the Magic Longsword empty-but-not-an-error case.

- [ ] **Step 7: Commit**

```bash
git add src/tools/how-to-obtain.ts src/server.ts src/db.ts test/how-to-obtain.test.ts
git commit -m "feat: add tibia_how_to_obtain tool unifying drops, vendors and quest rewards"
```

---

### Task 9: `build-index` command

**Why:** Without this the server cannot be used by anyone who does not already have a database file.

**Verified invocation (run end-to-end 2026-09-10, 3m13s, 14 MB, exit 0):**

```bash
uvx --from tibiawikisql==9.0.0 tibiawikisql generate --skip-images -o <path>
```

Only the `uvx` path is implemented. The published Docker image `galarzaa90/tibiawiki-sql:9.0.0` exists, but its exact entrypoint was **not** verified, so encoding a guessed `docker run` line here would be a placeholder in disguise. Docker support is deferred until someone verifies the invocation.

**Files:**
- Create: `src/indexer/build-index.ts`
- Test: `test/build-index.test.ts`

**Interfaces:**
- Consumes: `resolveDbPath` (Task 2)
- Produces: `buildIndex(opts?: { targetPath?: string; run?: Runner }): Promise<string>`
  - `type Runner = (cmd: string, args: string[]) => { status: number | null; stderr: string }`

- [ ] **Step 1: Write the failing test**

The runner is injected so the test proves the command and the atomic rename without a 3-minute network crawl.

`test/build-index.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from '../src/indexer/build-index.ts';

test('invokes the pinned generator with --skip-images and installs atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'twmcp-'));
  const target = join(dir, 'tibiawiki.db');
  let seen: { cmd: string; args: string[] } | undefined;

  const result = await buildIndex({
    targetPath: target,
    run: (cmd, args) => {
      seen = { cmd, args };
      // Simulate the generator writing to the temp path it was given.
      writeFileSync(args[args.length - 1]!, 'fake-db');
      return { status: 0, stderr: '' };
    },
  });

  assert.equal(seen!.cmd, 'uvx');
  assert.ok(seen!.args.includes('--skip-images'), 'images must never be fetched');
  assert.ok(seen!.args.includes('tibiawikisql==9.0.0'), 'generator version must be pinned');
  assert.notEqual(seen!.args[seen!.args.length - 1], target, 'must build to a temp path, not the target');
  assert.equal(result, target);
  assert.ok(existsSync(target), 'temp file should be renamed into place');
});

test('a failing generator leaves no partial database behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'twmcp-'));
  const target = join(dir, 'tibiawiki.db');
  await assert.rejects(
    buildIndex({ targetPath: target, run: () => ({ status: 1, stderr: 'boom' }) }),
    /boom/,
  );
  assert.equal(existsSync(target), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find `../src/indexer/build-index.ts`.

- [ ] **Step 3: Implement `src/indexer/build-index.ts`**

```ts
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDbPath } from '../db.ts';

const GENERATOR = 'tibiawikisql==9.0.0';

export type Runner = (cmd: string, args: string[]) => { status: number | null; stderr: string };

const defaultRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] });
  return { status: r.status, stderr: r.stderr ?? '' };
};

export async function buildIndex(
  opts: { targetPath?: string; run?: Runner } = {},
): Promise<string> {
  const target = opts.targetPath ?? resolveDbPath();
  const run = opts.run ?? defaultRunner;

  mkdirSync(dirname(target), { recursive: true });
  // Build beside the target, then rename: a failed run never replaces a good index.
  const temp = join(dirname(target), `.tibiawiki.db.${process.pid}.tmp`);
  rmSync(temp, { force: true });

  const args = ['--from', GENERATOR, 'tibiawikisql', 'generate', '--skip-images', '-o', temp];
  const { status, stderr } = run('uvx', args);

  if (status !== 0) {
    rmSync(temp, { force: true });
    throw new Error(
      `Index generation failed (exit ${status}). Is 'uv' installed? See https://docs.astral.sh/uv/\n${stderr}`,
    );
  }
  if (!existsSync(temp)) {
    throw new Error(`Generator reported success but produced no file at ${temp}`);
  }
  renameSync(temp, target);
  return target;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS — both cases.

- [ ] **Step 5: Verify the real thing once, by hand**

```bash
node dist/index.js build-index
```

Expected: takes roughly 3 minutes, exits 0, and writes ~14 MB to the resolved cache path. Then confirm the server starts against it:

```bash
node dist/index.js serve < /dev/null
```

Expected: no `TibiaWiki index not found` error.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/build-index.ts test/build-index.test.ts
git commit -m "feat: add build-index command with atomic install"
```

---

### Task 10: Documentation, CI, and installability

**Why:** The attribution obligation is a licence condition, not a nicety, and an MCP server nobody can install is not finished.

**Files:**
- Create: `README.md`, `LICENSE`, `.github/workflows/ci.yml`, `server.json`
- Test: covered by the CI smoke run

**Interfaces:**
- Consumes: everything
- Produces: an installable, documented package

- [ ] **Step 1: Write `README.md`**

Must contain, verbatim, the attribution string from Global Constraints, plus:

```markdown
# tibiawiki-mcp

An offline MCP server for TibiaWiki. Answers attribute queries — "which creatures are
weak to fire and give over 500 experience", "what drops a Dragon Shield and how likely
is it", "where do I buy a Steel Helmet" — in milliseconds from a local SQLite snapshot.

The server makes no network calls. All data comes from a local index you build yourself.

## Install

    pnpm add -g tibiawiki-mcp
    tibiawiki-mcp build-index      # ~3 minutes, ~14 MB, requires `uv`

## Use with Claude Code

    claude mcp add --transport stdio tibiawiki -- npx -y tibiawiki-mcp

## Tools

| Tool | Answers |
|---|---|
| `tibia_search` | "Is there a thing called roughly X?" |
| `tibia_get` | "Tell me everything about X." |
| `tibia_find_creatures` | "Which creatures match these stats?" |
| `tibia_find_items` | "Which items match these stats?" |
| `tibia_how_to_obtain` | "Where do I get X?" |

## Refreshing

Re-run `tibiawiki-mcp build-index`. Every tool response reports `indexGeneratedAt`
so staleness is always visible.

## Attribution

Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by
CipSoft; game content and images are copyright CipSoft GmbH.

Index generated by [tibiawiki-sql](https://github.com/Galarzaa90/tibiawiki-sql) (Apache-2.0).
```

- [ ] **Step 2: Add `LICENSE`**

MIT, covering this repo's code only. The README's attribution section covers the data, which is CC BY-SA and not ours to relicense.

- [ ] **Step 3: Write the CI workflow**

`.github/workflows/ci.yml` — actions pinned to full commit SHAs (resolved 2026-09-10; re-resolve with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha` when bumping).

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
      - uses: pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda # v4.1.0
      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          node-version: '24'
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - name: MCP protocol smoke test
        run: |
          npx @modelcontextprotocol/inspector --cli \
            node dist/index.js --method tools/list
        env:
          TIBIAWIKI_MCP_DB: ${{ github.workspace }}/test/fixtures/tibiawiki-fixture.db
```

- [ ] **Step 4: Write `server.json` for the MCP registry**

`name` must equal `package.json`'s `mcpName`.

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.jakubmucha/tibiawiki-mcp",
  "description": "Offline TibiaWiki knowledge base: attribute queries over creatures, items, NPCs, quests and spells",
  "repository": { "url": "https://github.com/jakubmucha/tibiawiki-mcp", "source": "github" },
  "version": "0.1.0",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "tibiawiki-mcp",
      "version": "0.1.0",
      "transport": { "type": "stdio" }
    }
  ]
}
```

- [ ] **Step 5: Verify CI passes and the smoke test lists five tools**

Run locally first:

```bash
TIBIAWIKI_MCP_DB=$PWD/test/fixtures/tibiawiki-fixture.db \
  npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
```

Expected: JSON listing `tibia_search`, `tibia_get`, `tibia_find_creatures`, `tibia_find_items`, `tibia_how_to_obtain`.

- [ ] **Step 6: Commit**

```bash
git add README.md LICENSE .github/workflows/ci.yml server.json
git commit -m "docs: add README, licence, CI workflow and registry manifest"
```

---

## Completion Criteria

The plan is done when all of these hold:

- [ ] `pnpm test` is green, with no skipped tests.
- [ ] `pnpm build` produces `dist/` with no TypeScript errors.
- [ ] `npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list` lists exactly five tools.
- [ ] A real `tibiawiki-mcp build-index` run completes and the server serves against it.
- [ ] `grep -rE "fetch\(|https?://" src/ --include=*.ts` shows no network calls outside `src/indexer/`.
- [ ] The attribution string appears in `README.md` and in the server `instructions`.
