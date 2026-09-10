# TibiaWiki MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, read-only MCP server that answers attribute queries about Tibia ("which creatures are weak to fire and give over 500 exp?") in milliseconds from a local SQLite snapshot of TibiaWiki.

**Architecture:** A pinned upstream generator (`tibiawiki-sql`) produces a SQLite file at build time; the runtime is a stdio MCP server that reads that file through `node:sqlite` and never touches the network. One `createServer()` factory is bound to stdio in production and to an in-memory transport in tests.

**Tech Stack:** TypeScript 7, Node ≥22.13, `@modelcontextprotocol/server` 2.0.0, Zod 4, `node:sqlite` (stdlib), `node:test` (stdlib), pnpm 10 with supply-chain hardening.

**Spec:** `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md`

**Review tier:** single (`reviewer`). `scripts/review-tier.py ff3b6a4` computes `none`, but that reflects the docs-only diff at the time; the expected change set is application code with no auth, secrets, concurrency, data-loss or shared-infrastructure surface, which is `single`.

**Revision note (v2):** This plan was revised after the 2026-09-10 gate returned *Needs revision*. All twelve blockers from that stamp (preserved at the bottom) are resolved in the text below. Each fix was reproduced against `data/tibiawiki.db`, the npm registry, live `tsc` 7.0.2, real `pnpm` 10.33.0, or Node's published API metadata.

## Global Constraints

Every task's requirements implicitly include this section.

- **Runtime makes no network calls.** Network access exists only in `src/indexer/`.
- **Two floors, deliberately different.**
  - **Runtime / `engines.node`: `>=22.13.0`.** `node:sqlite`/`DatabaseSync` were added in **v22.5.0** and stopped requiring `--experimental-sqlite` in **v22.13.0**. The published package ships compiled JavaScript, so consumers need nothing else.
  - **Development / CI: `>=22.18.0`.** Type-stripping is only enabled *by default* from **v22.18.0** (added v22.6.0 behind `--experimental-strip-types`), and the test command runs `.ts` directly. A contributor on 22.13–22.17 passes `engines` but cannot run the tests; the README must say so. CI runs Node 24.
- **`"type": "module"`**; ESM only.
- **Exact dependency pins** (pnpm `savePrefix: ''`), all older than the 7-day `minimumReleaseAge` gate: `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/client@2.0.0` (dev), `zod@4.5.4`, `typescript@7.0.2`, `@types/node@24.13.3`, `@modelcontextprotocol/inspector@2.4.0` (dev). **Do not bump to `zod@4.6.1`, `@types/node@24.13.4`, or `@modelcontextprotocol/inspector@2.6.0`** — all published 2026-09-09; with exact pins and `minimumReleaseAge: 10080` there is no fallback and `pnpm install` hard-fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. When choosing any pin, take one with **margin** rather than one sitting exactly on the 7-day line: the gate is computed in hours, so `inspector@2.5.0` (published 2026-09-02, exactly 7 days) is a coin flip — hence `2.4.0`. Verified ages on 2026-09-10: zod 4.5.4 = 11d, @types/node 24.13.3 = 63d, typescript 7.0.2 = 63d, both `@modelcontextprotocol/*@2.0.0` = 44d, inspector 2.4.0 = 14d.
- **No test-framework dependency** — `node:test` + `node:assert/strict`. **No SQLite driver dependency** — `node:sqlite` `DatabaseSync`, `{ readOnly: true }`.
- **Generator pinned** to `tibiawikisql==9.0.0`, always `--skip-images`.
- **`title` is the canonical identity.** `creature.name` is lowercase for **126 of 2,193** rows (`Dragon` → `name='dragon'`, `title='Dragon'`). Every tool uses `title` for identity, display, cross-tool round-tripping and URL construction. Lookup accepts either (both columns are `COLLATE NOCASE`); output always echoes `title`.
- **Default to `status = 'active'`.** Non-active rows are numerous (creature: 138 event, 45 unavailable, 39 deprecated, 13 ts-only, 1 raid; item: 186 unavailable, 67 event, 40 deprecated). Every query filters to active unless `include_inactive: true` is passed. This rule lives in `src/domain.ts` only.
- **SQL construction rule:** every SQL fragment comes from a **closed literal map keyed by an already-validated enum value**; no raw input is ever interpolated. This covers four places — the element→`modifier_*` map, the `sort`→`ORDER BY` map, the EAV comparison-operator map, and the search table map — not one. Each map gets a negative test.
- **Every tool** sets `annotations: { readOnlyHint: true, openWorldHint: false }` and declares an `outputSchema`. **Do not put `ttlMs`/`cacheScope` on tool results** — `CACHEABLE_RESULT_METHODS` in SDK 2.0.0 covers only `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read` and `server/discover`; `tools/call` is absent and `registerTool` has no `cacheHint` field.
- **Every tool response** carries `source: { page, url, indexGeneratedAt }` or a top-level `indexGeneratedAt`. Error results (`isError: true`) are exempt: they carry text only.
- **Attribution string** (committed verbatim in README and server `instructions`):
  `Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by CipSoft; game content and images are copyright CipSoft GmbH.`
- **DB path resolution**, shared by indexer and server: `$TIBIAWIKI_MCP_DB`, else `${XDG_CACHE_HOME:-~/.cache}/tibiawiki-mcp/tibiawiki.db`.
- **TDD**: failing test → watch it fail → implement → watch it pass → commit. Conventional-commit prefixes, no AI attribution trailers.

## Verified Facts (established 2026-09-10; do not re-derive)

| Fact | Value |
|---|---|
| Generator run | `uvx --from tibiawikisql==9.0.0 tibiawikisql generate --skip-images -o <path>` → 3m13s, 14 MB, exit 0 |
| Corpus | creature 2,193 · item 9,800 · npc 1,245 · quest 370 · spell 211 · creature_drop 19,496 · npc offers 13,964 · item_attribute 23,292 |
| Creature columns | `article_id, title, name, hitpoints, experience, armor, mitigation, speed, is_boss, bestiary_class, bestiary_level, bestiary_occurrence, spawn_type, location, walks_through, walks_around, status, modifier_<element>` |
| **No prose columns** | `creature` has **no** `history`, `notes`, `bestiary_text`, `behaviour` or `strategy` column — those are *wikitext infobox* fields the generator does not persist. The only prose-ish column anywhere is `item.flavor_text` |
| Elements | `physical earth fire ice energy death holy drown lifedrain healing` → `modifier_<element>` |
| Modifier convention | Percentage; 100 neutral. `> 100` = weak (takes extra). `< 100` = resistant |
| Item stats | **EAV, not columns.** `item_attribute(item_id, name, value)`, `value` is **TEXT** — `attack, defense, armor, required_level, required_vocation, weapon_type, hands, imbuement_slots`. Numeric compares need `cast(value as integer)` |
| Item columns | Only `item_class, item_type, type_secondary, weight, value_buy, value_sell, is_marketable, flavor_text, status` are real columns |
| Vendor direction | `npc_offer_sell` = NPC sells **to** the player (Steel Helmet 580g, 22 vendors). `npc_offer_buy` = NPC buys **from** the player (293g). Obtaining reads `npc_offer_sell`. `currency_id` joins to `item` (Gold Coin = `article_id` 2119) |
| Drop chances | `creature_drop.chance` is a REAL percentage, populated for 17,382 of 19,496 rows (89.2%) — **~11% are null, so nulls-last ordering is load-bearing** |
| `database_info` | **Key/value rows, not columns.** Keys: `generate_time, platform, python_version, timestamp, version` |
| Known answers | `Dragon` hp 1000, exp 700, `modifier_fire` **0** (immune), `modifier_ice` 110 · `Dragonbone Staff` from `Dragon` 0.0557% · `Magic Longsword` zero droppers/vendors/quests, attack 55 / defense 40 / required_level 140 · `Tarantula` `modifier_fire` 115, exp 120 · `Scarab` `modifier_fire` 118, exp 120 |
| SDK API | `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`; `McpServer`, `createMcpHandler`, `InMemoryTransport` from `@modelcontextprotocol/server`; `Client` from `@modelcontextprotocol/client`; `registerTool(name, {description, inputSchema, outputSchema, annotations}, cb)` with `inputSchema` a full `z.object(...)`; `ServerOptions.instructions` exists; `InMemoryTransport.createLinkedPair(): [InMemoryTransport, InMemoryTransport]` — verified working end to end |
| Build config | `module`/`moduleResolution` **`nodenext`** (`"node20"` is invalid in TS 7: `TS6046`). `.ts` specifiers need `allowImportingTsExtensions` **and** `rewriteRelativeImportExtensions`; verified to emit `./db.js` and run. `rootDir: "src"` gives a flat `dist/index.js`; `rootDir: "."` would emit `dist/src/index.js` and break `bin` |

## File Structure

| File | Responsibility |
|---|---|
| `src/index.ts` | bin entry; dispatches `serve` (default) vs `build-index` |
| `src/server.ts` | `createServer()` factory; registers all tools; owns server instructions |
| `src/db.ts` | DB path resolution, read-only open, schema probe, provenance |
| `src/domain.ts` | Sole home of policy: elements, modifier map, sort maps, status filter, entity types |
| `src/cursor.ts` | Opaque pagination cursor |
| `src/tools/{get,search,find-creatures,find-items,how-to-obtain}.ts` | One tool each |
| `src/indexer/build-index.ts` | Runs the pinned generator |
| `scripts/make-fixture.mjs` | Builds the committed test fixture from a full DB |
| `test/harness.ts` | `connect()` over `InMemoryTransport`, plus `FIXTURE` path helper |
| `test/fixtures/tibiawiki-fixture.db` | Committed trimmed DB (not gitignored) |

---

### Task 1: Project skeleton with hardened pnpm and a proven toolchain

**Why:** Nothing is verifiable until `tsc` and `node --test` demonstrably work together. Deliverable: a repo that typechecks, builds a flat `dist/index.js`, and runs one trivial test.

**Files:** Create `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.json`, `tsconfig.build.json`, `test/smoke.test.ts`

**Contract:** `pnpm typecheck` → `tsc --noEmit`; `pnpm build` → flat `dist/index.js`; `pnpm test` → typecheck then `node --test test/*.test.ts`.

**Literal config — committed verbatim.**

`pnpm-workspace.yaml` (hardening baseline from `dev-skills:node-supply-chain-hardening`):

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

`.npmrc`: `save-exact=true`

`package.json` key fields: `"type": "module"`, `"engines": {"node": ">=22.13.0"}`, `"packageManager": "pnpm@10.33.0"`, `"bin": {"tibiawiki-mcp": "dist/index.js"}`, `"files": ["dist"]`, `"mcpName": "io.github.jakubmucha/tibiawiki-mcp"`, the exact pins from Global Constraints, and scripts `typecheck`, `build`, `test` per the contract above.

`tsconfig.json` (typecheck everything, emit nothing):

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.mjs"]
}
```

`tsconfig.build.json` (emit the publishable tree):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "dist", "rootDir": "src", "sourceMap": true },
  "include": ["src/**/*.ts"]
}
```

**Behavior:** none (scaffolding).

**Tests to write:** one smoke test asserting `node:sqlite` is importable from the stdlib and round-trips a value through an in-memory database.

**Acceptance:**
- `pnpm install` succeeds and commits `pnpm-lock.yaml`. It must not fail with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`; if it does, a pin is younger than 7 days — pick the newest version older than that, do not weaken `minimumReleaseAge`.
- `pnpm test` passes.
- `pnpm build` succeeds. **The `dist/index.js` gate belongs to Task 4**, which is where `src/index.ts` first exists — Task 1 creates no production source, so asserting an emitted entry point here is unsatisfiable. Task 1 asserts only that the build runs clean and that `tsconfig.build.json` sets `rootDir: "src"` (the setting that later makes the path flat).
- If TypeScript 7.0.2 proves unworkable, fall back to `5.9.3` **and record the required tsconfig delta in this plan and in the README** — `module: nodenext` and `rewriteRelativeImportExtensions` behave differently across the two majors, so the fallback is not drop-in. A commit message alone is not sufficient record.

**Constraints:** pnpm only; no test framework, no SQLite driver.

---

### Task 2: Database access layer and the test fixture

**Why:** Every tool depends on opening the DB and trusting its shape. Fail-fast validation belongs here once. The fixture is folded in because the layer cannot be tested without it.

**Files:** Create `src/db.ts`, `scripts/make-fixture.mjs`, `test/fixtures/tibiawiki-fixture.db`, `test/db.test.ts`

**Contract:**

```ts
export type Provenance = { version: string; generatedAt: string };
export type TibiaDb = { db: DatabaseSync; provenance: Provenance; close(): void };
export class SchemaError extends Error {}
export function resolveDbPath(env?: NodeJS.ProcessEnv): string;
export function openDb(path?: string): TibiaDb;
```

**Behavior:**
- `resolveDbPath` implements the Global Constraints rule exactly.
- Missing file → `Error` naming the path and telling the user to run `tibiawiki-mcp build-index`.
- Schema probe throws `SchemaError` naming **the specific missing table or column**, hinting at a generator-version mismatch. Covers `creature`, `item`, `item_attribute`, `creature_drop`, `npc`, `npc_offer_sell`, `npc_offer_buy`, `quest`, `quest_reward`, **`spell`**, and `database_info`.
- **`database_info` is validated by _key_, not by column** — it is a key/value table. Require the keys `version` and `generate_time`.
- `provenance` reads those two keys, defaulting to `"unknown"` rather than throwing.
- Opened read-only.

**`scripts/make-fixture.mjs` — bounded retention contract.** Not "everything reachable". Retain exactly:
- **creature:** `Dragon`, `Dragon Lord`, `Rotworm`, `Demon`, `Cyclops` (the fire-immune / neutral cases) **plus `Tarantula` (`modifier_fire` 115) and `Scarab` (`modifier_fire` 118)** so fire-weakness tests have a non-empty result and pagination has ≥2 rows. Also retain one non-`active` creature so the status filter has something to exclude.
- **item:** every item referenced by a retained `creature_drop`, plus `Magic Longsword` (the zero-source case), `Steel Helmet` (`article_id` 2305, the vendor case) and **`Gold Coin` (`article_id` 2119, the currency join target)**.
- **npc / npc_offer_sell / npc_offer_buy:** every offer for a retained item, and every NPC referenced by a retained offer.
- **quest / quest_reward:** every reward row for a retained item, and its quest.
- **item_attribute:** every row for a retained item. **spell:** a handful, for the search-type test.
Then `vacuum`. It exists so the fixture is reproducible, not an opaque committed binary.

**Tests to write:**
- `resolveDbPath` honours the env override; falls back to the cache path.
- `openDb` on the fixture exposes `provenance.version === '9.0.0'` and an ISO-8601 `generatedAt`.
- Missing file throws mentioning `build-index`.
- A hand-built DB with a truncated `creature` table throws `SchemaError` naming the missing column.
- A DB whose `database_info` lacks the `version` key throws `SchemaError` (guards the key-vs-column confusion).

**Acceptance:**
- `node scripts/make-fixture.mjs data/tibiawiki.db test/fixtures/tibiawiki-fixture.db` writes a file under 1 MB.
- `pnpm test` passes with 6 tests in `db.test.ts`.
- `git check-ignore test/fixtures/tibiawiki-fixture.db` exits non-zero (the fixture is committed).
- A sanity query on the fixture returns **≥ 2** creatures with `modifier_fire > 100`.

---

### Task 3: Domain policy and pagination primitives

**Why:** The modifier convention, the status filter and every SQL fragment map are business policy. They must live in one place so no tool can drift and the model never has to know the conventions.

**Files:** Create `src/domain.ts`, `src/cursor.ts`, `test/domain.test.ts`

**Contract:**

```ts
export const ELEMENTS: readonly ['physical','earth','fire','ice','energy','death','holy','drown','lifedrain','healing'];
export type Element = (typeof ELEMENTS)[number];
export const elementSchema: z.ZodEnum<...>;
export function modifierColumn(element: Element): string;      // closed map; throws on unknown
export const WEAK_TO: (column: string) => string;              // `${column} > 100`
export const RESISTANT_TO: (column: string) => string;         // `${column} < 100`

export const ENTITY_TYPES: readonly ['creature','item','npc','quest','spell'];
export type EntityType = (typeof ENTITY_TYPES)[number];
export function searchTable(type: EntityType): string;         // closed map; throws on unknown
export function creatureSort(key: 'experience'|'hitpoints'|'title'): string;  // closed ORDER BY map
export function itemSort(key: 'title'|'weight'|'value'): string;              // closed ORDER BY map
export function eavOperator(op: 'gte'|'lte'): string;          // closed map -> '>=' | '<='
export function statusClause(includeInactive: boolean): string; // '' | "status = 'active'"

export function encodeCursor(offset: number): string;
export function decodeCursor(cursor: string | undefined): number;
```

**Behavior:**
- Each of the five map functions is **whitelist-only** and throws on an unknown key. Their return values are the only strings interpolated into SQL anywhere in the codebase.
- `statusClause(false)` yields the active-only filter; `statusClause(true)` yields an empty string that callers must handle without producing a dangling `and`.
- `decodeCursor(undefined) === 0`; malformed cursors throw.
- **`PROSE_FIELDS` is deleted.** The columns it named do not exist. `verbosity: 'detailed'` instead adds real columns — creature: `location`, `spawn_type`, `mitigation`, `bestiary_occurrence`, `walks_through`, `walks_around`; item: `flavor_text`. Export this as `DETAILED_CREATURE_FIELDS` / `DETAILED_ITEM_FIELDS`.

**Tests to write:**
- All 10 elements map to `modifier_<element>`; spot-check `fire` and `lifedrain`.
- **Negative test for each of the five maps**: an out-of-enum key throws rather than returning a fragment.
- `statusClause` returns the active filter by default and empty when inactive are included.
- Cursor round-trips; `undefined` → 0; garbage throws.
- Every name in `DETAILED_CREATURE_FIELDS` exists as a column in the fixture's `creature` table (guards the mistake that produced blocker 6).

**Acceptance:** `pnpm test` green.

---

### Task 4: Server factory, `tibia_get`, and the stdio entry point

**Why:** The first end-to-end slice. Proves the factory, tool registration, the in-memory harness and the stdio binding before four more tools land.

**Files:** Create `src/server.ts`, `src/tools/get.ts`, `src/index.ts`, `test/harness.ts`, `test/server.test.ts`

**Contract:**

```ts
// src/server.ts
export const ATTRIBUTION: string;
export function createServer(handle: TibiaDb): McpServer;

// src/tools/get.ts
export function sourceBlock(title: string, p: Provenance): { page: string; url: string; indexGeneratedAt: string };
export function registerGet(server: McpServer, handle: TibiaDb): void;

// test/harness.ts
export const FIXTURE: string;                       // resolves the fixture once, for all test files
export function connect(): Promise<{ client: Client; close(): Promise<void> }>;
```

**Behavior:**
- `createServer` builds `new McpServer({name, version}, {capabilities:{tools:{}}, instructions})`. The instructions state that the data is an offline snapshot, give `provenance.generatedAt` and the generator version, and end with `ATTRIBUTION`.
- `sourceBlock` uses **`title`** (canonical identity) → `https://tibia.fandom.com/wiki/<title with spaces as underscores, URI-encoded>`.
- **`tibia_get` covers all five entity types**, resolving blocker 8: input is `name` plus optional `type`; output is a **Zod discriminated union on `type`** so search → get round-trips for anything search can return. `outputSchema` is SDK-enforced, so the union must actually cover every returned shape. The five member shapes are enumerated explicitly, because Task 2's schema probe must cover exactly these columns and "their own columns" is not a contract:
  - **creature**: `title, hitpoints, experience, armor, speed, bestiary_class, is_boss, status`, the `modifiers` map, `loot[]`
  - **item**: `title, item_class, item_type, type_secondary, weight, value_buy, value_sell, is_marketable, flavor_text, status`, the reported EAV `attributes` bag
  - **npc**: `title, gender, city, subarea, location, x, y, z, status`
  - **quest**: `title, location, level_required, level_recommended, is_premium, quest_log, legend, status`
  - **spell**: `title, words, spell_type, element, mana, level, soul, is_premium, cooldown, status` (no `price` column — verified against the fixture schema)
  Every scalar is nullable unless the fixture proves otherwise; the Zod members must say so. All five carry `source`.
- Input also takes `include_inactive` (default false), applied to the requested entity itself: a non-active entity is reported as not found unless the flag is set. Every tool that accepts this flag documents which rows it governs, because the answer differs per tool (see `tibia_how_to_obtain`).
- When `type` is omitted and the name is ambiguous across types, return `isError: true` listing the matching types and asking the caller to disambiguate. Unknown name → `isError: true` pointing at `tibia_search`.
- `verbosity: 'detailed'` adds `DETAILED_CREATURE_FIELDS` / `DETAILED_ITEM_FIELDS` (Task 3), not the deleted prose fields.
- Loot is ordered by chance ascending **with nulls last** (~11% are null).
- **`src/index.ts` dispatches only `serve`** and exits 2 with usage for anything else. It must **not** reference `./indexer/build-index.ts` — `import()` is module-resolved and type-checked like a static import, so referencing a file Task 9 has not created yet is a hard `TS2307`. Task 9 adds the `build-index` branch as part of its own change.
- `test/harness.ts` uses **`InMemoryTransport.createLinkedPair()`** — no HTTP glue layer. (The SDK docs site claims this transport pins the 2025 era; the shipped type docs do not say so and a live round trip works. Protocol-era conformance is covered instead by Task 10's `inspector --cli` run against the real stdio binary. If a test ever needs to assert modern-era behaviour directly, use `createMcpHandler` + `handler.fetch` for that one test.)

**Tests to write:**
- `tools/list` includes `tibia_get` with `annotations.readOnlyHint === true`.
- `tibia_get` for `Dragon` returns hitpoints 1000, experience 700, `modifiers.fire === 0`, `title === 'Dragon'` (not `'dragon'`), and `source.url === 'https://tibia.fandom.com/wiki/Dragon'`.
- `tibia_get` for `Magic Longsword` returns the item shape and validates against the union `outputSchema`.
- Unknown name → `isError: true`.

**Acceptance:**
- `pnpm test` green, including the Dragon known-answer and the `title` casing assertion.
- `pnpm build && ls dist/index.js` succeeds — **flat, not `dist/src/index.js`**. (Moved here from Task 1: this is the first task that produces an entry point.)
- `node dist/index.js badcommand; echo $?` prints `2`.

**Constraints:** register tools **inside** the factory, never on a shared outer instance.

---

### Task 5: `tibia_search`

**Why:** The model rarely knows exact page names. Without this, `tibia_get` is a guessing game.

**Files:** Create `src/tools/search.ts`, `test/search.test.ts`; modify `src/server.ts`

**Contract:** `export function registerSearch(server: McpServer, handle: TibiaDb): void;`

**Behavior:**
- Input: `query` (non-empty), optional `types` (from `ENTITY_TYPES`), `include_inactive` (default false), `limit` (1–100, default 25), `cursor`. Output: `results: {title, type}[]`, optional `nextCursor`, `indexGeneratedAt`.
- Case-insensitive substring over `title`. Table names come from `searchTable()` (Task 3) — **never interpolated from input**.
- Ordering is deterministic and total: shortest `title` first, then `title` alphabetically, then **`type` alphabetically as the final tiebreaker** so cross-table pagination is stable.
- `nextCursor` only when more results remain.
- Note: `test/harness.ts` already exists from Task 4; this task consumes it and does not re-create it.

**Tests to write:**
- Searching `drag` returns `Dragon` (exact casing) and every result carries a `type`.
- `types: ['item']` returns only items, and the result set is **non-empty**.
- Paging with `limit: 1` twice yields two different rows in a stable order.
- A non-`active` entity is absent by default and present with `include_inactive: true`.

**Acceptance:** `pnpm test` green, all earlier tests still passing.

---

### Task 6: `tibia_find_creatures`

**Why:** The headline capability — the attribute query no upstream source can answer.

**Files:** Create `src/tools/find-creatures.ts`, `test/find-creatures.test.ts`; modify `src/server.ts`

**Contract:** `export function registerFindCreatures(server: McpServer, handle: TibiaDb): void;`

**Behavior:**
- Input: `weak_to[]`, `resistant_to[]`, `experience_min/max`, `hitpoints_min/max`, `bestiary_class`, `is_boss`, `location_contains`, `include_inactive` (default false), `sort` (`experience|hitpoints|title`, default `experience`), `limit` (1–100, default 25), `cursor`.
- Output: `results` with `title`, hitpoints, experience, bestiaryClass and the full `modifiers` map; plus `totalMatches`, optional `nextCursor`, `indexGeneratedAt`.
- Element filters compose `WEAK_TO`/`RESISTANT_TO` with `modifierColumn`; ordering comes from `creatureSort()`. **Every other filter binds parameters.**
- Sorting is nulls-last with `title` as tiebreak so pagination is stable.
- The tool description states the modifier convention explicitly (100 neutral; weak is above 100).

**Tests to write:**
- `weak_to: ['fire'], experience_min: 100` returns a **non-empty** set (the fixture guarantees `Tarantula` and `Scarab`), and every row has `modifiers.fire > 100` and `experience >= 100`. **Assert non-emptiness first** — a universal assertion over an empty array passes vacuously, which is exactly how this test was broken before.
- `weak_to: ['fire']` **excludes** `Dragon` (`modifier_fire = 0`) — the inversion guard.
- `limit: 1` on a query known to match ≥2 rows returns a `nextCursor`; following it yields a different creature; the final page has no `nextCursor`.
- A non-`active` creature is excluded by default.

**Acceptance:** `pnpm test` green, with the non-empty assertion present.

---

### Task 7: `tibia_find_items`

**Why:** The item equivalent of Task 6. Separate because item stats are EAV and the SQL is genuinely different work.

**Files:** Create `src/tools/find-items.ts`, `test/find-items.test.ts`; modify `src/server.ts`

**Contract:** `export function registerFindItems(server: McpServer, handle: TibiaDb): void;`

**Behavior:**
- Input: `item_class`, `item_type` (real columns); `weapon_type`, `vocation`, `attack_min/max`, `defense_min`, `armor_min`, `required_level_max` (EAV); `include_inactive`; `sort` (`title|weight|value`, default `title`, via `itemSort()`); `limit` (1–100, default 25); `cursor`.
- Output: `results` with `title`, itemClass, itemType, weight, valueBuy and an `attributes` bag limited to the reported set; plus `totalMatches`, optional `nextCursor`, `indexGeneratedAt`.
- **Numeric** EAV filters compile to `exists (select 1 from item_attribute a where a.item_id = item.article_id and a.name = ? and cast(a.value as integer) <op> ?)` where `<op>` comes from `eavOperator()`. The cast is load-bearing: the column is TEXT, so an uncast comparison string-sorts and `'9' > '55'`.
- **Text** EAV filters (`weapon_type`, `vocation`) are a *separate* predicate with no cast: `... and a.name = ? and a.value like ? collate nocase`, bound as `%value%`. `required_vocation` holds comma-joined plurals (e.g. `knights`), so vocation matching is substring-membership, not equality — `knight` must match `knights`. Both text filters get their own tests.
- Attribute names and values are **bound parameters**. Numeric attributes return as numbers, text as strings.
- `value` sort is on `value_buy` descending, nulls last.

**Tests to write:**
- `attack_min: 50` returns a **non-empty** set and every row has `attributes.attack >= 50`.
- `attack_min: 55, attack_max: 55, required_level_max: 140` finds `Magic Longsword`.
- A string-vs-numeric guard: a filter that would behave differently under TEXT comparison (e.g. `attack_min: 9` must include attack `55`, which a string compare would exclude) returns the numerically correct set.

**Acceptance:** `pnpm test` green.

---

### Task 8: `tibia_how_to_obtain`

**Why:** "Where do I get X?" is one user question spanning three tables. Consolidating means one model call and no chance of mis-joining them.

**Files:** Create `src/tools/how-to-obtain.ts`, `test/how-to-obtain.test.ts`; modify `src/server.ts`

**Contract:** `export function registerHowToObtain(server: McpServer, handle: TibiaDb): void;`

**Behavior:**
- Input: `item_name`, plus `include_inactive` (default false). Output: `item` (canonical `title`), `droppedBy: {creature, chance, min, max}[]`, `soldByNpcs: {npc, city, price, currency}[]`, `questRewards: string[]`, `note`, `source`.
- **`include_inactive` semantics here apply to the *related* rows, not the requested item**: by default, non-active creatures, NPCs and quests are excluded as sources, so a deprecated creature never appears as a live way to obtain something. The requested item is always returned if it exists, whatever its status; its status is echoed in the response.
- Vendors come from **`npc_offer_sell`** — the NPC selling to the player. Using `npc_offer_buy` is the defect this task exists to prevent. `currency_id` left-joins to `item`, defaulting to `Gold Coin`.
- Drops ordered by chance descending, **nulls last** — verified that Steel Helmet's first three droppers all have `chance = null`, so incidental ordering is not safe.
- No source at all → empty arrays plus a populated `note`, **not** an error. A name that matches no item → `isError: true` pointing at `tibia_search`.

**Tests to write:**
- `Dragon Shield` lists `Dragon` among `droppedBy` using canonical `title` casing.
- `Steel Helmet` vendors all quote `price >= 580` — proving `npc_offer_sell`, not the 293-gold buy side — and the set is non-empty.
- A drop list containing null chances places them last.
- `Magic Longsword` returns `isError` unset, `droppedBy: []`, and a non-empty `note`.

**Acceptance:** `pnpm test` green, all four cases.

---

### Task 9: `build-index` command

**Why:** Without this the server is unusable by anyone who does not already have a database file.

**Files:** Create `src/indexer/build-index.ts`, `test/build-index.test.ts`; modify `src/index.ts` (add the `build-index` branch — this is where it first becomes type-resolvable)

**Contract:**

```ts
export type Runner = (cmd: string, args: string[]) => { status: number | null; stderr: string };
export function buildIndex(opts?: { targetPath?: string; run?: Runner }): Promise<string>;
```

**Behavior:**
- Invokes `uvx --from tibiawikisql==9.0.0 tibiawikisql generate --skip-images -o <temp>`. Only `uvx` is implemented; the Docker image `galarzaa90/tibiawiki-sql:9.0.0` exists but **its entrypoint was not verified**, so a guessed `docker run` line would be a placeholder in disguise.
- **Creates the parent directory** (`mkdir` recursive) — on a clean machine `~/.cache/tibiawiki-mcp/` does not exist.
- Builds to a temp path beside the target, then **validates before replacing**: the temp file must exist and must pass `openDb`'s schema probe. Exit-zero plus file-exists is not sufficient evidence of a usable index.
- Only after validation does it `rename` into place.
- The temp filename is **unique per invocation** (pid plus a random suffix), so two concurrent runs cannot corrupt each other.
- The validating `openDb` handle is **closed before** the rename or the cleanup — an open handle blocks replacement on some platforms and leaks otherwise.
- Any failure — generator exit, missing file, failed validation, failed rename — removes the temp file and throws, quoting stderr and noting that `uv` must be installed.
- `run` is injected so tests prove the command line and the atomic install without a 3-minute crawl.
- Finally, add the `build-index` branch to `src/index.ts` (see Task 4).

**Tests to write:**
- Stub runner: command is `uvx`; args include `--skip-images` and the pinned `tibiawikisql==9.0.0`; the last arg is **not** the target; a valid DB ends up at the target.
- **Failure preserves an existing good index**: start with a valid database already at the target, run with a failing stub, assert the promise rejects **and the original file is byte-identical afterwards** and no temp file remains. (The previous version only checked that no file appeared, which a destructive implementation would also pass.)
- Generator "succeeds" but writes a schema-invalid file → rejects, target untouched byte-for-byte.
- Generator "succeeds" but writes **no** file → rejects naming the missing path.
- Rename fails (target directory made read-only) → rejects, temp file cleaned up, original intact.

**Acceptance:**
- `pnpm test` green.
- Manual, once: `node dist/index.js build-index` completes in ~3 minutes, exits 0, writes ~14 MB; then a real tool call against it succeeds (see Completion Criteria) — starting the process with closed stdin does not prove serving works.

---

### Task 10: Documentation, CI, and installability

**Why:** Attribution is a licence condition, not a nicety, and an MCP server nobody can install is not finished.

**Files:** Create `README.md`, `LICENSE`, `test/fixtures/README.md`, `.github/workflows/ci.yml`, `server.json`

**Behavior / literal content:**
- `README.md`: no network calls at runtime; install and `build-index` steps; `claude mcp add --transport stdio tibiawiki -- npx -y tibiawiki-mcp`; a table of the five tools; how to refresh; the attribution string **verbatim**; credit to `tibiawiki-sql` (Apache-2.0); and the TypeScript-fallback tsconfig delta if Task 1 took that branch.
- `test/fixtures/README.md`: CC-BY-SA attribution for the committed fixture, which is redistributed wiki content, plus the `make-fixture.mjs` command that reproduces it.
- `LICENSE`: MIT, **this repo's code only**. The data is CC BY-SA and not ours to relicense.
- `.github/workflows/ci.yml`: `permissions: contents: read`; checkout with `persist-credentials: false`; pnpm setup; Node 24; `pnpm install --frozen-lockfile`; `pnpm test`; `pnpm build`; then the MCP smoke step running the **pinned** `@modelcontextprotocol/inspector@2.4.0` (a dev dependency, not an unpinned `npx` fetch — an unpinned download contradicts the `minimumReleaseAge` posture this repo adopts) against `dist/index.js` with `TIBIAWIKI_MCP_DB` pointing at the committed fixture. Note the inspector needs Node ≥ 22.19 to run, above this package's own ≥22.13 floor; that is fine because it is a dev dependency and CI runs Node 24. Actions pinned to full commit SHAs (resolved 2026-09-10):
  - `actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8` # v5.0.0
  - `pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda` # v4.1.0
  - `actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444` # v5.0.0
- `server.json`: `$schema` `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`, `name` **exactly equal to** `package.json`'s `mcpName`, `packages[]` with `registryType: "npm"` and `transport: {type: "stdio"}`.

**Acceptance:**
- The pinned inspector lists exactly the five tools against `dist/index.js` and the fixture.
- CI passes on a pushed branch.

---

## Completion Criteria

- [ ] `pnpm test` green, no skipped tests.
- [ ] `pnpm build` emits a **flat** `dist/index.js` (not `dist/src/index.js`).
- [ ] Pinned inspector lists exactly five tools:
      `TIBIAWIKI_MCP_DB=$PWD/test/fixtures/tibiawiki-fixture.db pnpm exec mcp-inspector --cli node dist/index.js --method tools/list`
- [ ] A real `build-index` run completes **and a real tool call against the generated database returns data** — e.g. `tools/call tibia_find_creatures --tool-arg weak_to=fire` returns a non-empty result set. Process start alone is not evidence.
- [ ] No runtime network access, gated on imports and calls rather than URL text (the attribution string and `sourceBlock` both legitimately contain `https://`):
      `grep -rnE "\bfetch\(|node:http|node:https|undici|axios" src/ --include=*.ts | grep -v '^src/indexer/'` returns empty.
- [ ] The **packed package** installs and its bin runs: `pnpm pack`, install the tarball into a scratch directory, and run the installed `tibiawiki-mcp` executable. Invoking `node dist/index.js` proves the file works, not that the package is installable.
- [ ] The attribution string appears in `README.md`, `test/fixtures/README.md`, and the server `instructions`.
---

## Review (2026-09-10)

- **Verdict: Needs revision before implementation**
- Reviewers: `plan-final-reviewer` (opus; the fable dispatch died on a rate limit and was re-dispatched); `codex-consult` (high, 32,452 tokens); `grok-consult` — on request only, not run.
- Adopted: none. A `Needs revision` stamp changes nothing in the plan body; the plan returns to `superpowers:writing-plans`.

### Blockers to resolve in the revision

Independently reproduced by this session against `data/tibiawiki.db`, the npm registry, live `tsc` 7.0.2 and Node's published API metadata — not taken on a reviewer's word.

1. **Node floor is wrong.** `node:sqlite`/`DatabaseSync` were added in **v22.5.0**; the plan and spec both say `>=20`. Raise to `>=22.13.0` (both docs) — the floor came from the MCP SDK and was never checked against the stdlib module the design rests on.
2. **`pnpm install` hard-fails on the pins.** `minimumReleaseAge: 10080` (7 days) versus `zod@4.6.1` and `@types/node@24.13.4`, both published 2026-09-09 → `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. Exact pins leave no fallback. Newest eligible: `zod@4.5.4`, `@types/node@24.13.3`.
3. **tsconfig is invalid.** `moduleResolution: "node20"` does not exist in TS 7 (`node16 | nodenext | bundler`). `.ts` import specifiers additionally need `allowImportingTsExtensions` **plus** `rewriteRelativeImportExtensions`; that pair is verified to emit `./db.js` and run.
4. **Binary path is wrong.** `rootDir: "."` emits `dist/src/index.js`, not `dist/index.js` — breaking `bin`, Task 9's acceptance, the CI smoke step and two completion criteria. Use a build tsconfig with `rootDir: "src"`.
5. **Task 4's dynamic import does not defer type-checking.** `import()` is module-resolved like a static import → `TS2307` at Task 4. Task 4 dispatches only `serve`; Task 9 adds the `build-index` branch. The stated rationale is false and must be deleted.
6. **`PROSE_FIELDS` names five columns that do not exist.** `history`, `notes`, `bestiary_text`, `behaviour`, `strategy` are *wikitext infobox* fields, not `creature` columns — the error originated in spec §4.1. Either redefine `detailed` over real columns (`location`, `spawn_type`, `mitigation`, `bestiary_occurrence`, `item.flavor_text`) or drop `verbosity` from v1.
7. **`ttlMs`/`cacheScope` do not apply to `tools/call`.** `CACHEABLE_RESULT_METHODS` covers only the list/read/discover methods. The Global Constraint is unimplementable as written — move the hint to `tools/list` via `ServerOptions`, or drop it.
8. **`tibia_get` is creature-only but `tibia_search` returns five types**, and `outputSchema` is SDK-enforced, so search → get on an item dead-ends. Either define per-type output shapes or narrow search's default types and say so.
9. **The fixture cannot satisfy its own tests.** No fixture creature has `modifier_fire > 100` (Dragon/Dragon Lord/Demon 0, Rotworm/Cyclops 100), so Task 6's headline assertion passes vacuously on an empty array. Add a genuinely fire-weak creature, and enumerate per-table retention including the Steel Helmet vendor closure and Gold Coin (`article_id 2119`).
10. **`name` vs `title` is undefined and they differ** for 126 of 2,193 creatures (`Dragon` → `name='dragon'`, `title='Dragon'`). The plan's own Verified Facts table contradicts itself. Declare `title` canonical for identity, display and URL construction in Global Constraints.
11. **A completion criterion that can never pass.** `grep -rE "fetch\(|https?://" src/` always matches `ATTRIBUTION` and `sourceBlock`. Gate on imports/calls instead, excluding `src/indexer/`.
12. **`database_info` is key/value rows**, not columns — the Task 2 schema probe must check *keys* for that table or it fails on a valid database.

### Adopt as improvements in the revision

- Replace the `createMcpHandler` + `StreamableHTTPClientTransport`-with-injected-`fetch` harness with the SDK's **`InMemoryTransport.createLinkedPair()`** — verified working end to end. The current design is an HTTP-shaped glue layer around an in-process call, which CLAUDE.md forbids.
- **Decide a `status` filter policy in `src/domain.ts` before any SQL.** Non-active rows are numerous (creature: 39 deprecated, 138 event, 45 unavailable; item: 186 unavailable). Without it, `Giant Spider (Nostalgia)` is returned as a live answer. Retrofitting into five tools later is worse.
- **Restate the SQL-injection claim.** `modifierColumn` is *not* the only uninterpolated fragment — `sort`→`ORDER BY`, the EAV comparison operator, and the search table name all are. All are enum-gated so none is exploitable, but the false "one place" framing invites a reviewer to skip the other three. Restate as: every SQL fragment comes from a closed literal map keyed by an already-validated enum; add negative tests for the sort and table maps.
- One exported helper for fixture path resolution; `mkdir -p` the cache dir in `build-index`; pin `@modelcontextprotocol/inspector` in CI; add `persist-credentials: false` to checkout; assert nulls-last drop ordering explicitly (≈11% of `chance` values are null).

### Rejected

- *codex: replace Task 7's EAV `exists (... cast(a.value as integer) <op> ?)` with behavioural prose.* Reviewers disagreed; decided in favour of `plan-final-reviewer` — the EAV shape and the cast **are** the load-bearing spec, not an implementation body. Keeping it.

### Not worth changing

`**Review tier:** single` is correct (no auth, secrets, concurrency or data-loss surface; DB opened read-only). No over-specification — the remaining code blocks are export signatures and literal-is-spec config. The offline-snapshot architecture, pinned generator, stdlib SQLite/testing choices, five-tool split, and deferred Docker/hosted scope all stand. Synchronous `Runner` blocking ~3 min in a one-shot CLI is fine.
