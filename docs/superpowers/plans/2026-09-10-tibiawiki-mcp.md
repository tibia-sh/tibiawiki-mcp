# TibiaWiki MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, read-only MCP server that answers attribute queries about Tibia ("which creatures are weak to fire and give over 500 exp?") in milliseconds from a local SQLite snapshot of TibiaWiki.

**Architecture:** A pinned upstream generator (`tibiawiki-sql`) produces a SQLite file at build time; the runtime is a stdio MCP server that reads that file through `node:sqlite` and never touches the network. One `createServer()` factory is bound to stdio in production and driven in-process by tests.

**Tech Stack:** TypeScript 7, Node ≥20 (developed on 24), `@modelcontextprotocol/server` 2.0.0, Zod 4, `node:sqlite` (stdlib), `node:test` (stdlib), pnpm 10 with supply-chain hardening.

**Spec:** `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md`

**Review tier:** single (`reviewer`). `scripts/review-tier.py ff3b6a4` computes `none`, but that reflects the current docs-only diff; the expected change set is application code with no auth, secrets, concurrency, data-loss or shared-infrastructure surface, which is `single`.

## Global Constraints

Every task's requirements implicitly include this section.

- **Runtime makes no network calls.** Network access exists only in `src/indexer/`. A network call under `src/tools/` or `src/db.ts` is a defect.
- **Node `>=20`**; `"type": "module"`; ESM output only.
- **Exact dependency pins** (pnpm `savePrefix: ''`): `@modelcontextprotocol/server@2.0.0`, `zod@4.6.1`, `typescript@7.0.2`, `@types/node@24.13.4`, `@modelcontextprotocol/client@2.0.0` (dev).
- **No test-framework dependency** — `node:test` + `node:assert/strict`. **No SQLite driver dependency** — `node:sqlite` `DatabaseSync` with `{ readOnly: true }`.
- **Generator pinned** to `tibiawikisql==9.0.0`, always invoked with `--skip-images`.
- **Every tool** sets `annotations: { readOnlyHint: true, openWorldHint: false }`, declares an `outputSchema`, returns `structuredContent`, and returns `ttlMs`/`cacheScope` on list results.
- **Every tool response** carries `source: { page, url, indexGeneratedAt }` or a top-level `indexGeneratedAt`.
- **Attribution string** (committed verbatim in README and server `instructions`):
  `Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by CipSoft; game content and images are copyright CipSoft GmbH.`
- **DB path resolution**, one rule shared by indexer and server: `$TIBIAWIKI_MCP_DB`, else `${XDG_CACHE_HOME:-~/.cache}/tibiawiki-mcp/tibiawiki.db`.
- **TDD**: write the failing test, watch it fail, implement, watch it pass, commit. Conventional-commit prefixes, no AI attribution trailers.

## Verified Facts (established 2026-09-10; do not re-derive)

These were measured against live sources and a real generated database. Treat them as given.

| Fact | Value |
|---|---|
| Generator run | `uvx --from tibiawikisql==9.0.0 tibiawikisql generate --skip-images -o <path>` → 3m13s, 14 MB, exit 0 |
| Corpus | creature 2,193 · item 9,800 · npc 1,245 · quest 370 · spell 211 · creature_drop 19,496 · npc offers 13,964 · item_attribute 23,292 |
| Creature stats | Typed columns on `creature`: `hitpoints`, `experience`, `armor`, `mitigation`, `speed`, `is_boss`, `bestiary_class`, `location`, `modifier_<element>` |
| Elements | `physical earth fire ice energy death holy drown lifedrain healing` → columns `modifier_<element>` |
| Modifier convention | Percentage; 100 is neutral. `> 100` = takes extra damage (weak). `< 100` = resistant |
| Item stats | **EAV, not columns.** `item_attribute(item_id, name, value)` with `value` as **TEXT** — `attack`, `defense`, `armor`, `required_level`, `required_vocation`, `weapon_type`, `hands`, `imbuement_slots`. Numeric compares need `cast(value as integer)` |
| Item columns | Only `item_class`, `item_type`, `type_secondary`, `weight`, `value_buy`, `value_sell`, `is_marketable` are real columns |
| Vendor direction | `npc_offer_sell` = NPC sells **to** the player (Steel Helmet 580g). `npc_offer_buy` = NPC buys **from** the player (293g). Obtaining reads `npc_offer_sell`. Both have `currency_id` joining back to `item` |
| Drop chances | `creature_drop.chance` is a REAL percentage, populated for 17,382 of 19,496 rows (89.2%) |
| Known answers | `Dragon` hp 1000, exp 700, `modifier_fire` 0 (immune) · `Dragonbone Staff` from `Dragon` chance ≈ 0.0557% · `Magic Longsword` has zero droppers (genuinely unobtainable) · `Dragon Shield` dropped by `dragon` among others |
| SDK API | `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`; `McpServer`/`createMcpHandler` from `@modelcontextprotocol/server`; `Client`/`StreamableHTTPClientTransport` from `@modelcontextprotocol/client`; `registerTool(name, {description, inputSchema, outputSchema, annotations}, cb)` with `inputSchema` a full `z.object(...)` (raw shapes deprecated); `ServerOptions.instructions` exists |

## File Structure

| File | Responsibility |
|---|---|
| `src/index.ts` | bin entry; dispatches `serve` (default) vs `build-index` |
| `src/server.ts` | `createServer()` factory; registers all tools; owns server instructions |
| `src/db.ts` | DB path resolution, read-only open, schema probe, provenance |
| `src/domain.ts` | Single source of truth for elements, modifier mapping, verbosity |
| `src/cursor.ts` | Opaque pagination cursor |
| `src/tools/{get,search,find-creatures,find-items,how-to-obtain}.ts` | One tool each |
| `src/indexer/build-index.ts` | Runs the pinned generator |
| `scripts/make-fixture.mjs` | Builds the committed test fixture from a full DB |
| `test/harness.ts` | Shared in-process MCP client harness |
| `test/fixtures/tibiawiki-fixture.db` | Committed trimmed DB (not gitignored) |

---

### Task 1: Project skeleton with hardened pnpm and a proven toolchain

**Why:** Nothing else is verifiable until `tsc` and `node --test` demonstrably work together. Deliverable: a repo that builds and runs one trivial test.

**Files:** Create `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.json`, `test/smoke.test.ts`

**Contract:** `pnpm build` → `dist/`; `pnpm test` runs `node --test` over compiled output.

**Literal config — committed verbatim.**

`pnpm-workspace.yaml` (the hardening baseline from `dev-skills:node-supply-chain-hardening`):

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

`package.json` key fields: `"type": "module"`, `"engines": {"node": ">=20"}`, `"packageManager": "pnpm@10.33.0"`, `"bin": {"tibiawiki-mcp": "dist/index.js"}`, `"files": ["dist"]`, `"mcpName": "io.github.jakubmucha/tibiawiki-mcp"`, scripts `build: tsc`, `pretest: pnpm build`, `test: node --test dist/test/*.test.js`, and the exact dependency pins from Global Constraints.

`tsconfig.json` key fields: `target es2023`, `module`/`moduleResolution` `node20`, `strict`, `noUncheckedIndexedAccess`, `outDir dist`, `rootDir .`, include `src/**/*.ts` and `test/**/*.ts`, and — because **TypeScript 7 removed auto-inclusion of `@types/*`** — an explicit `"types": ["node"]`.

**Behavior:** none (scaffolding only).

**Tests to write:** one smoke test asserting `node:sqlite` is importable from the stdlib and round-trips a value through an in-memory database.

**Acceptance:**
- `pnpm install` succeeds and produces a committed `pnpm-lock.yaml`.
- `pnpm test` passes.
- If `typescript@7.0.2` or `@types/node@24.13.4` fail to compile, fall back to `typescript@5.9.3` and record the change in the commit message. **Do not proceed with a red build.**

**Constraints:** pnpm only; do not add a test framework or a SQLite driver.

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
- `resolveDbPath` implements the Global Constraints rule exactly: `$TIBIAWIKI_MCP_DB` wins, else `${XDG_CACHE_HOME:-$HOME/.cache}/tibiawiki-mcp/tibiawiki.db`.
- `openDb` on a missing file throws an `Error` whose message names the path and tells the user to run `tibiawiki-mcp build-index`.
- `openDb` probes the schema and throws `SchemaError` naming **the specific missing table or column**, with a hint that the index was built by a different generator version. Required shape covers the tables and columns this plan actually queries: `creature`, `item`, `item_attribute`, `creature_drop`, `npc`, `npc_offer_sell`, `npc_offer_buy`, `quest`, `quest_reward`, `database_info`.
- `provenance` reads `version` and `generate_time` from `database_info`, defaulting to `"unknown"` rather than throwing.
- The database is opened read-only.

**`scripts/make-fixture.mjs`:** copies a full DB, deletes all but a handful of named creatures (`Dragon`, `Dragon Lord`, `Rotworm`, `Demon`, `Cyclops`) plus everything reachable from them, keeps `Magic Longsword` and `Steel Helmet` for the known-answer cases, then `vacuum`s. It exists so the fixture is reproducible rather than an opaque committed binary.

**Tests to write:**
- `resolveDbPath` honours the env override.
- `resolveDbPath` falls back to the cache path.
- `openDb` on the fixture exposes `provenance.version === '9.0.0'` and an ISO-8601 `generatedAt`.
- `openDb` on a missing file throws mentioning `build-index`.
- `openDb` on a hand-built DB with a truncated `creature` table throws `SchemaError` naming the missing column.

**Acceptance:**
- `node scripts/make-fixture.mjs data/tibiawiki.db test/fixtures/tibiawiki-fixture.db` writes a file under 1 MB.
- `pnpm test` passes with 5 tests in `db.test.ts`.
- `git check-ignore test/fixtures/tibiawiki-fixture.db` exits non-zero (the fixture is committed).

---

### Task 3: Domain policy and pagination primitives

**Why:** "Weak to fire means `modifier_fire > 100`" is business policy. It must live in exactly one place so no tool can drift and the model never has to know the convention.

**Files:** Create `src/domain.ts`, `src/cursor.ts`, `test/domain.test.ts`

**Contract:**

```ts
export const ELEMENTS: readonly ['physical','earth','fire','ice','energy','death','holy','drown','lifedrain','healing'];
export type Element = (typeof ELEMENTS)[number];
export const elementSchema: z.ZodEnum<...>;          // reused by every tool inputSchema
export function modifierColumn(element: Element): string;
export const WEAK_TO: (column: string) => string;     // -> `${column} > 100`
export const RESISTANT_TO: (column: string) => string; // -> `${column} < 100`
export const verbositySchema: z.ZodDefault<z.ZodEnum<['concise','detailed']>>;
export const PROSE_FIELDS: readonly ['history','notes','bestiary_text','behaviour','strategy'];

export function encodeCursor(offset: number): string;
export function decodeCursor(cursor: string | undefined): number;
```

**Behavior:**
- `modifierColumn` is **whitelist-only**: its return value is interpolated into SQL, so an unknown element must throw rather than pass through. This is the one place where a string reaches SQL uninterpolated by a parameter, and it is why the whitelist is load-bearing.
- `encodeCursor`/`decodeCursor` round-trip an offset through an opaque base64url token. `decodeCursor(undefined)` is `0`. A malformed cursor throws.

**Tests to write:**
- All 10 elements map to `modifier_<element>`; spot-check `fire` and `lifedrain`.
- An element outside the whitelist throws.
- Cursor round-trips; `undefined` yields 0; garbage throws.

**Acceptance:** `pnpm test` green.

---

### Task 4: Server factory, `tibia_get`, and the stdio entry point

**Why:** The first end-to-end slice. Proves the factory, tool registration, the in-process test harness and the stdio binding all work before four more tools are layered on.

**Files:** Create `src/server.ts`, `src/tools/get.ts`, `src/index.ts`, `test/harness.ts`, `test/server.test.ts`

**Contract:**

```ts
// src/server.ts
export const ATTRIBUTION: string;               // the Global Constraints string, verbatim
export function createServer(handle: TibiaDb): McpServer;

// src/tools/get.ts
export function sourceBlock(page: string, p: Provenance): { page: string; url: string; indexGeneratedAt: string };
export function registerGet(server: McpServer, handle: TibiaDb): void;

// test/harness.ts
export function connect(): Promise<{ client: Client; close(): Promise<void> }>;
```

**Behavior:**
- `createServer` constructs `new McpServer({name:'tibiawiki-mcp', version}, {capabilities:{tools:{}}, instructions})`. The `instructions` state that the data is an offline snapshot, give `provenance.generatedAt` and the generator version, and end with `ATTRIBUTION`.
- `sourceBlock` builds `https://tibia.fandom.com/wiki/<page with spaces as underscores, URI-encoded>`.
- `tibia_get` input: `name` (exact page name), `verbosity`. Output: name, type, hitpoints, experience, armor, speed, bestiaryClass, a `modifiers` map over all 10 elements, a `loot` array of `{item, chance, min, max}` ordered by chance ascending with nulls last, an optional `prose` map (only at `detailed`, drawn from `PROSE_FIELDS`), and `source`.
- An unknown name returns `isError: true` with text pointing the model at `tibia_search` — **not** a JSON-RPC error. JSON-RPC errors are reserved for malformed calls.
- `src/index.ts` is a shebanged bin dispatching `serve` (default) and `build-index`. `build-index` is loaded by **dynamic import** so `serve` does not depend on Task 9 existing yet. An unknown command exits 2 with usage on stderr.
- `test/harness.ts` builds `createMcpHandler(() => createServer(handle))` and connects a real `Client` over `StreamableHTTPClientTransport` whose `fetch` calls `handler.fetch` in-process — no subprocess, no port.

**Tests to write:**
- `tools/list` includes `tibia_get` with `annotations.readOnlyHint === true`.
- `tibia_get` for `Dragon` returns hitpoints 1000, experience 700, `modifiers.fire === 0`, and `source.url === 'https://tibia.fandom.com/wiki/Dragon'`.
- An unknown creature name yields `isError: true`.

**Acceptance:** `pnpm test` green, including the Dragon known-answer case.

**Constraints:** register tools **inside** the factory, never on a shared outer instance — the factory may be invoked per request.

---

### Task 5: `tibia_search`

**Why:** The model rarely knows exact page names. Without this, `tibia_get` is a guessing game.

**Files:** Create `src/tools/search.ts`, `test/search.test.ts`; modify `src/server.ts`

**Contract:** `export function registerSearch(server: McpServer, handle: TibiaDb): void;`

**Behavior:**
- Input: `query` (non-empty substring), optional `types` restricted to `creature|item|npc|quest|spell`, `limit` (1–100, default 25), `cursor`. Output: `results: {name, type}[]`, optional `nextCursor`, `indexGeneratedAt`.
- Matching is a case-insensitive substring over `name`. Results are ordered shortest-name-first then alphabetically, so an exact-ish match surfaces above longer incidental matches.
- One prepared statement per table, built from the fixed whitelist. **The table name must never be interpolated from user input.**
- `nextCursor` is present only when more results remain.

**Tests to write:**
- Searching `drag` returns `Dragon` among the results, and every result carries a `type`.
- Restricting `types: ['item']` returns only items.
- (Fold Task 4's inline `connect()` into `test/harness.ts` and re-point `test/server.test.ts` at it.)

**Acceptance:** `pnpm test` green, all earlier tests still passing.

---

### Task 6: `tibia_find_creatures`

**Why:** The headline capability — the attribute query no upstream source can answer.

**Files:** Create `src/tools/find-creatures.ts`, `test/find-creatures.test.ts`; modify `src/server.ts`

**Contract:** `export function registerFindCreatures(server: McpServer, handle: TibiaDb): void;`

**Behavior:**
- Input: `weak_to[]`, `resistant_to[]` (both `elementSchema`), `experience_min/max`, `hitpoints_min/max`, `bestiary_class`, `is_boss`, `location_contains`, `sort` (`experience|hitpoints|name`, default `experience`), `limit` (1–100, default 25), `cursor`.
- Output: `results` with name, hitpoints, experience, bestiaryClass and the full `modifiers` map; plus `totalMatches`, optional `nextCursor`, `indexGeneratedAt`.
- Element filters go through `WEAK_TO`/`RESISTANT_TO` composed with `modifierColumn`. **Every other filter binds parameters** — no string interpolation of user values.
- Sort is `experience`/`hitpoints` descending, `name` ascending, always with nulls last and `name` as a tiebreak so pagination is stable.
- The tool description must state the modifier convention explicitly (100 is neutral; weak means more than 100) so the model does not have to infer it.

**Tests to write:**
- `weak_to: ['fire'], experience_min: 100` returns only creatures whose `modifiers.fire > 100` and `experience >= 100`.
- `weak_to: ['fire']` **excludes** `Dragon` — it is fire-immune at `modifier_fire = 0`. This is the regression guard for inverting the comparison.
- `limit: 1` returns a `nextCursor`, and following it yields a different creature.

**Acceptance:** `pnpm test` green, including the Dragon exclusion case.

---

### Task 7: `tibia_find_items`

**Why:** The item equivalent of Task 6. A separate task because item stats are stored as EAV and the SQL is genuinely different work.

**Files:** Create `src/tools/find-items.ts`, `test/find-items.test.ts`; modify `src/server.ts`

**Contract:** `export function registerFindItems(server: McpServer, handle: TibiaDb): void;`

**Behavior:**
- Input: `item_class`, `item_type` (real columns); `weapon_type`, `vocation`, `attack_min/max`, `defense_min`, `armor_min`, `required_level_max` (EAV attributes); `sort` (`name|weight|value`), `limit`, `cursor`.
- Output: `results` with name, itemClass, itemType, weight, valueBuy and an `attributes` bag limited to the reported set (`attack`, `defense`, `armor`, `required_level`, `imbuement_slots`, `required_vocation`, `weapon_type`, `hands`); plus `totalMatches`, optional `nextCursor`, `indexGeneratedAt`.
- EAV filters compile to a correlated `exists (select 1 from item_attribute a where a.item_id = item.article_id and a.name = ? and cast(a.value as integer) <op> ?)`. Numeric attributes are cast; text attributes match case-insensitively. Attribute names and values are **bound parameters**.
- Numeric attributes are returned as numbers, text attributes as strings.

**Tests to write:**
- `attack_min: 50` returns only items whose reported `attributes.attack >= 50`.
- `attack_min: 55, attack_max: 55, required_level_max: 140` finds `Magic Longsword` (its verified attributes are attack 55, defense 40, required_level 140).

**Acceptance:** `pnpm test` green.

---

### Task 8: `tibia_how_to_obtain`

**Why:** "Where do I get X?" is one user question spanning three tables. Consolidating means one model call instead of three, and no chance of mis-joining them.

**Files:** Create `src/tools/how-to-obtain.ts`, `test/how-to-obtain.test.ts`; modify `src/server.ts`

**Contract:** `export function registerHowToObtain(server: McpServer, handle: TibiaDb): void;`

**Behavior:**
- Input: `item_name`. Output: `item`, `droppedBy: {creature, chance, min, max}[]`, `soldByNpcs: {npc, city, price, currency}[]`, `questRewards: string[]`, a `note`, and `source`.
- Vendors come from **`npc_offer_sell`** — the NPC selling to the player. Using `npc_offer_buy` here is the defect this task exists to avoid. `currency_id` left-joins back to `item` for the currency name, defaulting to `Gold Coin`.
- Drops are ordered by chance descending, nulls last.
- An item with no drop, vendor or quest source returns **empty arrays and a populated `note`**, not an error — some items are genuinely unobtainable. An item that does not exist at all returns `isError: true` pointing at `tibia_search`.

**Tests to write:**
- `Dragon Shield` lists `Dragon` among `droppedBy`.
- `Steel Helmet` vendors all quote `price >= 580`, proving `npc_offer_sell` was used rather than the 293-gold buy-side.
- `Magic Longsword` returns `isError` unset, `droppedBy: []`, and a non-empty `note`.

**Acceptance:** `pnpm test` green, all three cases.

---

### Task 9: `build-index` command

**Why:** Without this the server is unusable by anyone who does not already have a database file.

**Files:** Create `src/indexer/build-index.ts`, `test/build-index.test.ts`

**Contract:**

```ts
export type Runner = (cmd: string, args: string[]) => { status: number | null; stderr: string };
export function buildIndex(opts?: { targetPath?: string; run?: Runner }): Promise<string>;
```

**Behavior:**
- Invokes `uvx --from tibiawikisql==9.0.0 tibiawikisql generate --skip-images -o <temp>`. Only the `uvx` path is implemented: the Docker image `galarzaa90/tibiawiki-sql:9.0.0` exists but **its entrypoint was not verified**, so encoding a guessed `docker run` line would be a placeholder in disguise. Docker support is deferred.
- Builds to a temp path beside the target and `rename`s on success, so a failed run never replaces a good index and never leaves a partial file.
- Non-zero exit removes the temp file and throws an error quoting stderr and mentioning that `uv` must be installed.
- Success with no output file is also an error.
- The `run` dependency is injected so tests prove the command line and the atomic install without a 3-minute crawl.

**Tests to write:**
- With a stub runner: the command is `uvx`, the args include `--skip-images` and the pinned `tibiawikisql==9.0.0`, the last arg is **not** the target path, and the file ends up at the target.
- With a failing stub runner: the promise rejects quoting stderr, and no file exists at the target.

**Acceptance:**
- `pnpm test` green.
- Manual, once: `node dist/index.js build-index` completes in roughly 3 minutes, exits 0, writes ~14 MB; then `node dist/index.js serve < /dev/null` starts without the `index not found` error.

---

### Task 10: Documentation, CI, and installability

**Why:** Attribution is a licence condition, not a nicety, and an MCP server nobody can install is not finished.

**Files:** Create `README.md`, `LICENSE`, `.github/workflows/ci.yml`, `server.json`

**Behavior / literal content:**
- `README.md` states that the server makes no network calls, gives the install and `build-index` steps, the `claude mcp add --transport stdio tibiawiki -- npx -y tibiawiki-mcp` line, a table of the five tools, how to refresh, and — verbatim — the attribution string, plus credit to `tibiawiki-sql` (Apache-2.0).
- `LICENSE`: MIT, covering **this repo's code only**. The data is CC BY-SA and not ours to relicense; the README's attribution section covers it.
- `.github/workflows/ci.yml`: `permissions: contents: read`; checkout, pnpm setup, Node 24; `pnpm install --frozen-lockfile`; `pnpm test`; then an MCP smoke step running `npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list` with `TIBIAWIKI_MCP_DB` pointed at the committed fixture. Actions pinned to full commit SHAs (resolved 2026-09-10):
  - `actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8` # v5.0.0
  - `pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda` # v4.1.0
  - `actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444` # v5.0.0
- `server.json` for the MCP registry: `$schema` `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`, `name` **exactly equal to** `package.json`'s `mcpName`, a `packages[]` entry with `registryType: "npm"` and `transport: {type: "stdio"}`.

**Acceptance:**
- `TIBIAWIKI_MCP_DB=$PWD/test/fixtures/tibiawiki-fixture.db npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list` lists exactly the five tools.
- CI passes on a pushed branch.

---

## Completion Criteria

- [ ] `pnpm test` green, no skipped tests.
- [ ] `pnpm build` produces `dist/` with no TypeScript errors.
- [ ] `npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list` lists exactly five tools.
- [ ] A real `tibiawiki-mcp build-index` run completes and the server serves against it.
- [ ] `grep -rE "fetch\(|https?://" src/ --include=*.ts` shows no network calls outside `src/indexer/`.
- [ ] The attribution string appears in `README.md` and in the server `instructions`.
