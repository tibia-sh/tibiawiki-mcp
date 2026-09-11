# Ability Area Grids — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell an agent the *shape* of a creature's attack — that a Dragon's Fire Wave hits a five-by-nine cone — as a grid it can reason over, not a picture it cannot see.

**Architecture:** A build-time enrichment pass, run by `build-index` between generation and validation, fetches the wiki's 114 tile patterns and the ability→pattern references the generator discards, and writes them to additive `mcp_*` tables in the same database. At runtime `tibia_get` renders a matched ability's grid as ASCII. The runtime still makes no network calls.

**Tech Stack:** unchanged — TypeScript 7, Node ≥22.13 runtime / ≥22.18 dev, `@modelcontextprotocol/server` 2.0.0, Zod 4, `node:sqlite`, `node:test`, pnpm 10.

**Spec:** extends `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md`.
**Spike:** `docs/superpowers/spikes/2026-09-11-ability-scene-join.md` — **read it including the addendum.** The addendum is the authority: it re-measures over the full corpus and corrects two facts the original spike got wrong.

**Revision:** this is the **third** draft. The first was stamped `Needs revision` on 2026-09-11 (stamp retained at the foot of this file) over nine blocking issues, two of which were wrong facts in a table marked *"do not re-derive"*. Draft 2 was stamped `Needs revision` over six more, the worst a 39.7% identity drift that every one of its own tests would have passed. Both stamps are retained at the foot of this file. Every fact below carries its provenance.

**Review tier:** single (`reviewer`). No auth, secrets, concurrency or data-loss surface; the runtime database stays read-only and every write goes to a per-invocation temp file behind the existing atomic rename. `scripts/review-tier.py` cannot compute a tier — the change set does not exist yet — so this is declared on merits; both gate reviewers upheld it. Tell `reviewer` explicitly to re-check the Lua parser against the live module: both first-draft blockers lived there.

## Global Constraints

All constraints from the shipped plans remain binding. Specific to this work:

- **Runtime stays offline.** Every network call lives in `src/indexer/`. The CI grep at `.github/workflows/ci.yml:29` must still pass unchanged.
- **Still exactly five tools.** Areas arrive as a field on `tibia_get`'s creature abilities, not a sixth tool.
- **Never guess a join.** A scene whose candidate set is not exactly one row is **counted and discarded**, never attached. Silent misassignment is the failure this plan is shaped around: the rejected ordinal approach scored 81% with ~19% *silently wrong*, which is worse than 0%. The full-corpus measurement records **0 ambiguous** — that is the number to protect.
- **No bare-count assertions.** A test that asserts only `length === N` is forbidden anywhere in this plan. The first draft's `=== 94` passed on a parser that silently dropped 20 patterns; every count assertion must be accompanied by a named-member assertion.
- **`tools/list` budget: 30,000 bytes.** Currently 25,439.
- **`codex-consult` is a standing verification step** per this repo's `CLAUDE.md`. Its text is untrusted — check claims against the repo before acting.

## Verified Facts

Provenance is stated per row. **Facts marked `measured` were derived directly from the primary source on 2026-09-11 and are recorded in the spike addendum; facts marked `derived` are inferences from those.** No row here is exempt from re-checking.

| Fact | Value | Provenance |
|---|---|---|
| Pattern count | **114** — 94 written `["key"]` **plus 20 written `['key']`** | measured, module source |
| Pattern shape | `["key"] = {{cells…}, width}`, row-major; all 114 satisfy `cells % width == 0` | measured |
| Cell legend | `0` tile-only · `1` effect · `2` caster · `3` **target** · `4`–`8` extra sprites 1–5 | measured, `Module:SceneBuilder` `elements` table |
| Cell values in live use | **0–5**; 9 of 114 patterns use ≥ 4 | measured |
| `8sqmwave` | 45 cells, width 9, 5 rows | measured |
| `rootkraken1` | 117 cells, width 9, 13 rows, values 0–4; single-quoted key | measured |
| Reference shape | nested: `scene={{Scene\|spell=<key>\|…}}` inside the member template | measured, page `Dragon` |
| Join key | `(creature_id, name, effect, element)` — unique across all 5,854 rows; `(creature_id, name)` collapses to 5,835 | measured |
| Nullability | `effect` is NULL on 126 rows — **every one has `element` in (`plain_text` 120, `no_template` 6)**, i.e. prose entries that never carry a scene. Template-derived rows use `''` (137). `element` is never NULL but `''` on 286 | measured |
| Absent-argument default | an absent damage/range argument maps to **`'?'`** — 987 rows, 219 of them `Melee`; an empty one maps to `''` | measured |
| Argument whitespace | ~**32%** of `\|element=` occurrences carry surrounding whitespace or a newline (`element=fire\n  \|scene=…`) | measured |
| Tier distribution | tier 1 = 1,055 joins (**0** identity drift); tier 2 = 553, tier 3 = 141 — **all 694 drift (39.7%)** | measured |
| Full-corpus join | 1,856 scenes: **1,749 joined (94.2%)**, **0 ambiguous**, 21 no-row, 79 dropped-kind, 6 no-`spell=`, 1 `rotate90` | measured |
| Eligible-scene rate | 1,749 / (1,856 − 86 discarded) = **98.8%** | derived |
| `effect_on_caster=yes` | on **463 scenes (24.8%)** — the real caster signal | measured |
| Per-kind mapping | `Melee` → name `Melee`, element default `physical`; `Healing` → element always `healing`, effect from `range=`, name defaults `Self-Healing` but varies; `Summon` → name is the summoned creature, effect the amount, element `summon`; an absent damage/range argument defaults to `'?'` for every kind | measured |
| Batch limit | anonymous `titles` limit **50**, `highlimit` 500 | measured, `action=paraminfo` |
| Corpus size | 2,209 creature pages; 559 carry ≥ 1 scene; 101 of 114 keys referenced | measured |

**Deliberately excluded, so a reviewer does not read these as oversights:** `look_direction` (the grid is already caster-relative, so it adds nothing geometric — YAGNI); `missile=`/`missile_distance` (projectile flavour, not area); `sprite_1`…`sprite_5` names (13 and 2 occurrences — cells `4`–`8` render as digits and the legend explains them).

## File Structure

| File | Responsibility |
|---|---|
| `src/area.ts` | `AreaPattern`/`Area` types, grid → ASCII rendering, `AREA_LEGEND` (runtime, no network) |
| `src/indexer/wiki-api.ts` | Minimal MediaWiki client — batching, User-Agent, retry, injectable fetch |
| `src/indexer/scene-data.ts` | Fetch and parse `Module:SceneBuilder/data` |
| `src/indexer/ability-scenes.ts` | Extract and join ability→pattern references from creature wikitext |
| `src/indexer/enrich.ts` | Open the temp index writable, create and fill the `mcp_*` tables, report stats |
| `src/indexer/build-index.ts` | Run enrichment between generate and validate; accept an injected enricher |
| `src/db.ts` | Probe the new tables; keep `openDb` read-only |
| `src/tools/get.ts` | `area` on creature abilities |
| `scripts/make-fixture.mjs` | Retain `mcp_*` rows for the anchors |

---

### Task 1: Area patterns — type, parse, render

**Why:** Pure and offline, so it is buildable and testable before any network code exists. It is also what the agent ultimately consumes.

**Files:** Create `src/area.ts`, `src/indexer/scene-data.ts`, `test/area.test.ts`, `test/fixtures/scene-data.lua`

**Interfaces — Produces:**
```ts
export type AreaPattern = { key: string; width: number; cells: number[] };
export type Area = {
  key: string; width: number; height: number; cells: number[];
  ascii: string; effectTiles: number; effectOnCaster: boolean; legend: string;
};
export function renderArea(p: AreaPattern, opts: { effectOnCaster: boolean }): Area;
export const AREA_LEGEND: string;
export function parseSceneData(lua: string): { patterns: AreaPattern[]; rejected: Array<{ key: string; reason: string }> };
```

**Behavior:**
- **The key regex must accept both `["key"]` and `['key']`.** 20 of the 114 entries use single quotes. This is the single highest-risk line in the plan: a double-quote-only regex returns exactly 114 − 20 = 94 and looks self-consistent.
- Parse the key and the body **separately**. A naive numeric scrape of `["8sqmwave"] = {{…}, 9}` captures the `8` from the key name and yields 46 values for a 45-cell grid.
- `parseSceneData` validates rather than trusts: positive integer width, non-negative integer cells, `cells.length % width === 0`, duplicate key is an error not last-one-wins. Every rejection is returned with its reason.
- `renderArea` emits `.` tile-only, `#` effect, `@` caster, `*` target, and the literal digits `4`–`8` for extra sprites, one space between columns, newline per row. **`3` is the target tile — not a direction marker.** A value outside 0–8 renders as `?` so genuinely new wiki values degrade visibly.
- `effectTiles` counts `1`s only and is named for exactly what it counts. `effectOnCaster` is **not derived from the grid** — cell values are mutually exclusive, so a caster tile can never also read as effect. It is passed in from the Scene's `effect_on_caster` argument.
- `AREA_LEGEND` is committed verbatim and must describe all of `0`–`8`.

**Tests to write** (committed Lua fixture, no network):
- the fixture yields 114 patterns **and** `patterns.find(p => p.key === 'rootkraken1')` is defined — the named assertion is what makes the count non-tautological, and `rootkraken1` is single-quoted, so a double-quote-only regex fails here
- `8sqmwave` is 45 cells / width 9 / 5 rows and renders to the exact expected ASCII block
- `rootkraken1` is 117 cells / width 9 / 13 rows and its rendering contains a literal `4`
- a `3` renders as the target glyph and **not** as `>`
- `AREA_LEGEND` mentions target and extra-sprite meanings
- a cells-not-divisible-by-width entry lands in `rejected` with a reason and is absent from `patterns`
- a duplicate key is rejected
- a cell value of `9` renders as `?`
- `effectTiles` counts only `1`s — asserted on a pattern containing `2`, `3` and `4`
- `renderArea(p, { effectOnCaster: true })` and `false` differ only in that field

**Acceptance:** `pnpm test` green, no network. `test/fixtures/scene-data.lua` is the live module **committed verbatim** (~16.8 KB); malformed, duplicate-key and out-of-range cases are passed to `parseSceneData` as inline strings, so they do not contradict the 114-pattern assertion on the same file.

---

### Task 2: Wiki API client

**Why:** Two enrichment steps need the same batching, User-Agent and retry. One reviewable file keeps the network surface inside `src/indexer/`.

**Files:** Create `src/indexer/wiki-api.ts`, `test/wiki-api.test.ts`

**Interfaces — Produces:**
```ts
export type Fetcher = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
export type Clock = { sleep(ms: number): Promise<void> };
export type WikiApi = {
  pageWikitext(titles: string[]): Promise<Array<{ title: string; wikitext: string }>>;
  moduleSource(title: string): Promise<string>;
  categoryMembers(category: string): Promise<string[]>;
};
export function createWikiApi(opts?: { fetcher?: Fetcher; clock?: Clock; userAgent?: string; timeoutMs?: number }): WikiApi;
```

**Behavior:**
- Uses the **native `Response`** shape — call `res.headers.get(...)`, not a bespoke `header()` adapter.
- Batches at **50 titles per request** (the measured anonymous limit) and follows `continue` to exhaustion.
- Sends a descriptive, contactable User-Agent. Never impersonates a browser or a named crawler.
- **MediaWiki returns HTTP 200 with an `error` object for API-level failures.** Those throw with `code` and `info` and are never retried as transient. Retryable: 429, 502, 503, 504 and transport failures, with bounded backoff, then throw naming URL and status.
- `Retry-After: 2` means **2 seconds — `sleep(2000)`**. A per-request timeout via `AbortSignal`.
- `fetcher` and `clock` are injected so every test runs offline and backoff is tested without real waiting.

**Tests to write:** 120 titles split into exactly 3 requests **and** the third request's titles are asserted by name; `continue` followed until absent; `Retry-After: 2` sleeps exactly `2000` on the injected clock then retries; a 200 carrying an `error` object throws with its code and records exactly **one** fetch call; a 500 is not retried while a 503 is; a persistent transport failure throws naming the URL (a rejected `fetch` has no status); the User-Agent on **every** recorded request is asserted to contain the product and contact token — presence alone is the weak-assertion pattern this repo bans.

**Acceptance:** `pnpm test` green with zero real network — assert the injected fetcher is the only call path.

---

### Task 3: Extract and join ability scenes

**Why:** The heart of the feature. Every rule below is measured, and several correct a specific failure that scored 0% or silently mis-attached.

**Files:** Create `src/indexer/ability-scenes.ts`, `test/ability-scenes.test.ts`, `test/fixtures/creature-wikitext/*.txt`

**Interfaces — Consumes:** `AreaPattern` (Task 1). **Produces:**
```ts
export type SceneRef = {
  // The MATCHED ROW's normalised identity — never the extracted text. See Behavior.
  abilityName: string; abilityEffect: string; abilityElement: string;
  patternKey: string; effectOnCaster: boolean;
};
export type ExtractStats = {
  scenes: number; joined: number; ambiguous: number; noRow: number;
  discardedKind: number; discardedNoSpell: number; discardedRotate: number;
  unparsedMember: number;   // scene present, enclosing member opener not canonical
};
export function extractSceneRefs(
  wikitext: string,
  abilityRows: ReadonlyArray<{ name: string; effect: string | null; element: string | null }>,
): { refs: SceneRef[]; stats: ExtractStats };
```

**Behavior — each rule is measured, not preference:**
- **`patternKey` comes from the nested `scene={{Scene|spell=<key>|…}}`.** The reference is a template inside a template.
- **Split template arguments at depth 0, counting `{{ }}` as well as `[[ ]]`.** Counting only links shreds every scene-carrying member, because the Scene itself contains pipes.
- **Discard the leading empty argument.** A member body begins with `|`, so a naive split puts `''` at index 0 and shifts every positional argument by one. This alone scored **0% joined** in measurement — a total failure that still produced clean, summing counters.
- **Apply the per-kind mapping.** Handle only the kinds the generator recognises — `Ability`, `Melee`, `Healing`, `Summon` — and map each as measured: `Ability` → positional name/damage plus `element=`; `Melee` → name `Melee`, element defaults `physical`; `Healing` → element always `healing`, effect from `range=`, name defaults `Self-Healing`; `Summon` → name is the summoned creature, effect the amount, element `summon`. A generic parser that ignores this scores 0%, not a reduced rate.
- **Match the template name exactly**, with no whitespace tolerance, mirroring the generator.
- **Collapse wiki links to display text** and decode HTML entities (`&amp;`, `&#45;`, `&nbsp;`).
- **Capture the whole `element=` value including spaces** — the wikitext itself says `element=fire field`.
- **Honour named arguments** (`name=`, `damage=`, `range=`, `amount=`) alongside positional ones.
- **`SceneRef` carries the matched row's identity, not the extracted text.** A fallback tier matches *precisely when* the dropped component differs, so every tier-2 and tier-3 join drifts: 694 of 1,749 (39.7%) measured. Storing the extracted form writes rows that count toward the build gate and are unretrievable by Task 5's join. Highest-risk rule in the plan, and a tier-1 test anchor cannot detect a violation.
- **Trim each argument's surrounding whitespace; preserve interior spaces.** Real wikitext is `element=fire\n  |scene=…`, and ~32% of `element=` occurrences carry whitespace. Interior spaces still matter (`element=fire field`), so trim the ends only.
- **An absent damage/range argument maps to `'?'`; an empty one maps to `''`.** 987 rows carry `'?'`. A *supplied-but-empty* argument counts as supplied and is therefore not droppable by a fallback tier — The Rootkraken supplies `element=` with an empty value.
- **Normalise NULL to `''` defensively when matching.** NULL occurs only on `plain_text`/`no_template` rows, which never carry a scene, so this guards rather than carries the join.
- Match in tiers, accepting only a tier yielding exactly one row: `(name, effect, element)` → `(name, effect)` → `(name)`. **A tier may only drop a component the wikitext did not supply** — falling back past an explicit `element=` can uniquely select a row that contradicts it.
- Count and discard, never attach: a scene on `Haste`/`Debuff`/`Outfit` (79 measured), a Scene with no `spell=` (6, inline `input_array`), a Scene with `rotate90=yes` (1 — the stored grid would render transposed and silently wrong).
- **Count scenes whose enclosing member opener is not canonical** (`unparsedMember`, 18 measured: `{{Ability |` ×8, `{{Haste\n  |` ×8, `{{Ability\n …|` ×1, `{{healing|` ×1). Discarding them is correct — all 10 `Ability`/`healing` variants were checked and the generator emits **no row** for any of them — but they must be *visible*. Unseen, they leave the `scenes` denominator silently, so a parser regression that started missing legitimate members would shrink the denominator and could *raise* the reported rate. `scenes` must equal the raw `scene={{Scene` count: 1,856 parsed + 18 unparsed = **1,874**.
- Capture `effect_on_caster` (463 scenes) onto the ref.
- Every counter is mutually exclusive and they sum to `scenes`.

**Tests to write** (committed wikitext fixtures, no network):
- Dragon's `{{Ability|Fire Wave|100-170|element=fire|scene={{Scene|spell=8sqmwave|…}}}}` yields `patternKey === '8sqmwave'` — proves nested extraction and the leading-empty-argument fix together
- a `{{Healing|range=40-70|scene={{Scene|…|effect_on_caster=yes}}}}` joins to `Self-Healing`/`40-70`/`healing` with `effectOnCaster === true` — the per-kind mapping regression
- a `{{Melee|scene=…}}` with no element joins to element `physical`, and a `{{Summon|Fire Elemental|1|scene=…}}` joins with element `summon` — **label both as defensive**: no `Melee` or `Summon` member carries a scene anywhere in the corpus, so these fixtures are author-invented and exercise a path that never fires in production
- a `{{Ability |` opener (space before the pipe) increments `unparsedMember` and yields no ref
- a wiki-linked name joins (`Throws [[Distance Fighting|Knives]]` → `Throws Knives`)
- an `element=fire field` member joins, proving the value is not truncated at the space
- a **verbatim** `element=fire\n  |scene=…` fixture joins — the newline regression; the flattened examples above are illustrative only, and every committed fixture must be a raw page dump
- The Rootkraken's `Death and Holy AoE` (row carries `effect ''` **and** `element ''`) joins — the real empty-string anchor
- an `{{Ability|Root|element=rooted}}` with no damage argument joins to a row whose `effect` is `'?'`
- **a tier-2 join returns the matched row's `(effect, element)`, not the extracted ones** — wikitext omitting `element=` against a row whose element is `physical` must yield `abilityElement === 'physical'`. Without this, 39.7% of stored rows are unretrievable
- a member supplying `element=fire` does **not** fall back to a lone `(name)` row whose element is `ice`
- a `{{Haste}}` member increments `discardedKind` and yields no ref, even when an `element='haste'` row exists
- a `rotate90=yes` Scene increments `discardedRotate`; a Scene with no `spell=` increments `discardedNoSpell`
- `{{Ability |` with trailing whitespace is discarded rather than matched loosely
- a name matching two rows increments `ambiguous` and yields no ref
- counters sum to `scenes` in every case

**Acceptance:** `pnpm test` green. Counter arithmetic asserted, since the 0% run proved summing counters are not evidence of correctness. **`abilityRows` in every test must be copied verbatim from the real index**, not hand-written — otherwise both sides of the join are author-invented and will agree with a wrong parser.

---

### Task 4: Enrichment tables, wired into `build-index`

**Why:** The patterns and refs must reach the runtime without the runtime ever going online.

**Files:** Create `src/indexer/enrich.ts`, `test/enrich.test.ts`; modify `src/indexer/build-index.ts`, `test/build-index.test.ts`, `src/db.ts`, `test/db.test.ts`, `test/fixture-shape.test.ts`, `scripts/make-fixture.mjs`, `test/fixtures/tibiawiki-fixture.db`, `test/fixtures/README.md`

**Interfaces — Consumes:** `WikiApi` (Task 2), `parseSceneData` (Task 1), `extractSceneRefs` (Task 3). **Produces:**
```ts
export type EnrichStats = ExtractStats & {
  patterns: number; rejectedPatterns: Array<{ key: string; reason: string }>;
  stored: number; danglingKey: number;
};
export type Enricher = (dbPath: string, api: WikiApi) => Promise<EnrichStats>;
export function enrich(dbPath: string, api: WikiApi): Promise<EnrichStats>;
// build-index gains injection points; existing opts are unchanged:
export async function buildIndex(
  opts?: { targetPath?: string; run?: Runner; enrich?: Enricher; api?: WikiApi },
): Promise<string>;
```

**Schema — additive; no upstream table is altered:**
- `mcp_area_pattern(key TEXT PRIMARY KEY, width INTEGER NOT NULL, cells TEXT NOT NULL)` — `cells` a JSON array.
- `mcp_ability_area(creature_id INTEGER NOT NULL, ability_name TEXT NOT NULL, ability_effect TEXT NOT NULL DEFAULT '', ability_element TEXT NOT NULL DEFAULT '', pattern_key TEXT NOT NULL REFERENCES mcp_area_pattern(key), effect_on_caster INTEGER NOT NULL, PRIMARY KEY (creature_id, ability_name, ability_effect, ability_element))`.
  **Every key column is `NOT NULL`, and that is what makes the primary key work.** SQLite permits NULLs in primary-key columns of an ordinary table and treats them as distinct — verified locally: with a nullable key column the duplicate insert was accepted and the table held two rows; with `NOT NULL` columns the same duplicate was rejected. Since Task 3 already normalises NULL and `''` to one value, storing the normalised form removes the hazard at the source rather than papering over it with an expression index.
  **Not an ordinal**: ordinals shift when the generator drops a member mid-list, which is how the rejected approach misassigned ~19% silently.
- `mcp_schema_version(version INTEGER NOT NULL)` — exactly one row.

**Behavior:**
- **`build-index` runs generate → enrich → validate → atomic rename, in that order.** Enrichment must precede validation: once `assertSchema` requires the `mcp_*` tables, validating the generator's raw output would reject it.
- **`enrich` opens its own writable handle.** `openDb` is `{ readOnly: true }` and schema-validating (`src/db.ts:84`) and cannot serve here.
- **`enrich` is given the temp path, never the live target**, preserving the guarantee that a failure leaves a pre-existing index byte-identical.
- A `pattern_key` absent from `mcp_area_pattern` is counted in `danglingKey` and never stored; the FK makes this enforced rather than merely intended.
- Idempotent, proved by mutating the source and asserting stale rows do not survive — re-running identical input proves nothing.
- **Fail explicitly when the eligible denominator is zero** — an empty or fully-discarded corpus makes the ratio `NaN`, and `NaN < 0.95` is false, so a naive comparison passes on no data.
- `stored` = `joined − danglingKey`; the `EnrichStats` fields are therefore **not** all mutually exclusive outcomes and must not be summed as if they were. Print `danglingKey` prominently on the first real run — its corpus-wide value is unmeasured.
- `build-index` **prints** `EnrichStats` and **fails if `stored / (scenes − discardedKind − discardedNoSpell − discardedRotate)` falls below 95%.** Measured: 1,749 / 1,770 = **98.8%**. The denominator excludes scenes that *should* be dropped, so the gate measures what was actually lost; the first draft's numerator would have let every pattern be rejected while still reporting a passing rate.
- The probe additionally rejects a `mcp_schema_version` that is absent, unparseable, holds ≠ 1 row, or is newer than the supported version. Its `SchemaError` must name `tibiawiki-mcp build-index`, as existing probe errors do — requiring `mcp_*` makes every already-installed index fail to open, and the message is the entire remedy.
- **Resolve page title → `creature.article_id` in enrichment**, since `extractSceneRefs` receives only ability rows. `Category:Creatures` holds 2,209 members against 2,193 creature rows and includes non-creature pages (`Bestiary/Classes`, list pages); those are skipped and **not charged against the gate**, with their own counter.
- The probe must check **columns before row counts**: `test/db.test.ts` builds seven synthetic schema-only databases and asserts the error names the dropped column. A row-count check ordered first makes all seven report the wrong message.
- **Order inside this task: enrich a real index → regenerate the fixture → only then tighten the probe.** `make-fixture.mjs` copies a generated database, so the `mcp_*` tables exist only if the source was already enriched; tightening first turns the whole suite red for an unrelated reason.
- `make-fixture.mjs`: `mcp_area_pattern` **and `mcp_schema_version`** join `KEEP_WHOLE` — every table outside `USED`/`keepByType`/`KEEP_WHOLE` is emptied wholesale, and an emptied version row makes the new probe reject the fixture. `mcp_ability_area` needs its **own branch** pruning by `creature_id`; it cannot ride on `keepByType`, which prunes by an `article_id` it does not have.
- `test/fixture-shape.test.ts`: both new tables join `REQUIRED_NON_EMPTY`, and the 1.5 MB fixture budget gets its assertion here. Its final loop empties any table not in those sets, and the `pragma foreign_key_check` sweep cannot prune `mcp_ability_area` by creature because the FK points at the pattern table.

**Tests to write:** enrichment against a fixture DB with an injected fetcher creates all three tables, and `mcp_area_pattern` contains `rootkraken1` by name; re-running after a source mutation leaves no stale rows; a dangling pattern key is rejected by the FK and counted; a below-threshold rate fails the build; **a zero eligible denominator fails the build rather than passing on `NaN`**; `mcp_schema_version` survives fixture regeneration; an enrichment failure inside `build-index` leaves a pre-existing index **byte-identical** (sha256 compared); **all five existing `build-index.test.ts` cases pass with an injected no-op enricher and make zero fetches**; the probe rejects a DB whose `mcp_schema_version` is absent, duplicated, or newer, and the error text names `build-index`; inserting the same `(creature_id, ability_name, '', '')` twice is rejected by the primary key.

**Acceptance:** `pnpm test` green including all 103 existing tests. One manual `build-index` completes and prints the counters; record the observed wall-clock in the commit message as a measurement, not a budget.

---

### Task 5: Serve the area on creature abilities

**Why:** The payload. An agent asking what a Fire Wave hits gets a grid.

**Files:** Modify `src/tools/get.ts`, `src/db.ts`; create `test/area-detail.test.ts`

**Interfaces — Consumes:** `Area`, `renderArea`, `AREA_LEGEND` (Task 1); `mcp_*` tables (Task 4).

**Behavior:**
- Each `creature.abilities[]` entry gains `area: Area | null`.
- **The join matches the stored identity against `coalesce(creature_ability.effect, '')`**, and likewise for `element`. Stored columns are `NOT NULL` (Task 4) and hold the **matched row's** values (Task 3), so both sides agree by construction. `coalesce` is defensive: NULL occurs only on `plain_text`/`no_template` rows, which never carry a scene. Note `is` would be wrong here — `'' is NULL` is false.
- `null` is the honest answer for an ability with no matched scene — most abilities have none, and the 5.8% non-join rate describes scene-carrying members only, not abilities at large. It must never be an empty grid.
- `legend` accompanies every non-null area, so a model never has to infer the glyphs.
- One prepared statement joined per creature — no query per ability.
- `tibia_get`'s description gains one sentence about areas; the tool count stays five.

**Tests to write:** Dragon's `Fire Wave` returns `key === '8sqmwave'` and an `ascii` matching the expected 5×9 cone exactly; Dragon's `Self-Healing` returns `effectOnCaster === true`; The Rootkraken's death AoE returns the 13-row `rootkraken1` grid containing a `4`; **a tier-2-joined ability returns a non-null area** — the 39.7% identity-drift regression, which a tier-1 anchor such as `Fire Wave` cannot detect; The Rootkraken's `Death and Holy AoE` (`effect ''`, `element ''`) returns its area, exercising normalisation with real data; an ability with no matched scene returns `area: null`, not an empty grid; `legend` is present on every non-null area; `tools/list` stays under 30,000 bytes; a creature whose abilities all lack scenes still returns successfully.

**Acceptance:** `pnpm test` green; `tools/list` recorded and under budget; a real `tibia_get` against the full index shows Dragon's Fire Wave cone.

---

## Completion Criteria

- [ ] `pnpm test` green, **0 skipped**, including all 103 pre-existing tests.
- [ ] Exactly five tools; `tools/list` under **30,000 bytes** (recorded in the commit).
- [ ] No runtime network: `grep -rnE "\bfetch\(|node:http|node:https|undici|axios" src/ '--include=*.ts' | grep -v '^src/indexer/'` returns empty.
- [ ] `mcp_area_pattern` holds **114** rows and contains `rootkraken1` by name.
- [ ] A real `build-index` reports stored/eligible **≥ 95%**, prints `danglingKey` and `unparsedMember`, and fails rather than passing when the eligible denominator is zero.
- [ ] `scenes` equals the raw `scene={{Scene` occurrence count — **1,874** at time of writing — so no scene is invisible to the counters.
- [ ] A tier-2 or tier-3 ability returns a non-null area at runtime — the 39.7% identity-drift regression.
- [ ] Dragon's `Fire Wave` returns the `8sqmwave` grid; `Self-Healing` reports `effectOnCaster: true`; an unmatched ability returns `area: null`.
- [ ] A `{{Haste}}` scene and a `rotate90=yes` scene are each discarded and counted — asserted by test.
- [ ] Enrichment failure leaves a pre-existing index byte-identical (sha256).
- [ ] The five existing `build-index` tests make zero network calls.
- [ ] Fixture stays under 1.5 MB, **asserted in `test/fixture-shape.test.ts`** — an ungated criterion will not be checked. Currently 1.0 MB.
- [ ] `mcp_area_pattern` and `mcp_ability_area` are in `REQUIRED_NON_EMPTY` and survive fixture regeneration.

## Review 1 — first draft (2026-09-11)

- **Verdict: Needs revision before implementation**
- Reviewers: plan-final-reviewer; codex-consult (high, 40s, 27049 tokens); grok-consult — on request only, not run
- Tier: **single**, upheld by both reviewers. `scripts/review-tier.py` cannot compute it — the change set does not exist yet — so the declaration is judged on merits: no auth, secrets, or concurrency surface, writes confined to a temp file behind the existing atomic rename.
- Adopted: none — a `Needs revision` verdict leaves the body untouched. The findings below were the brief for draft 2, and all nine are addressed there; this stamp records the state of **draft 1**, not the current body.

### Blocking — confirmed against the primary source, not taken on trust

1. **The pattern count is 114, not 94, and the test asserting 94 would pass on a broken parser.** `Module:SceneBuilder/data` holds 94 `["key"]` plus **20 `['key']`** entries. A double-quote-only regex — the obvious first implementation — returns exactly 94 and satisfies the Task 1 assertion while silently discarding 20 patterns, including `rootkraken1`/`rootkraken2`, whose creature is already a committed fixture anchor. Ninth instance of the repo's "test passes while feature is broken" pattern, and it was authored into the plan.
2. **The cell legend is wrong.** `Module:SceneBuilder` defines `[3] = target_element`, not a direction marker; `[4]`–`[8]` are extra sprites. Values **0–5 are in live use**. The plan renders `3` as `>` and commits `AREA_LEGEND` verbatim — shipping wrong data to agents as authoritative, and `affectedTiles` reports 0 for patterns built from `4`/`5`.
3. **`casterInArea` is not derivable** from `{key,width,cells}`: cell values are mutually exclusive, so a caster tile can never also read as affected. The real signal is the Scene template's `effect_on_caster=yes`, which the plan discards.
4. **Task 3 never states where `patternKey` comes from.** The reference is a *nested* `scene={{Scene|spell=<key>}}`; the depth rule mentions only `[[ ]]`, so a splitter tracking links alone shreds every scene-carrying member.
5. **`buildIndex` has no injection point.** All five existing cases in `test/build-index.test.ts` inject only `run`; an unconditional `enrich()` sends them to the live wiki, and Task 4's own failure test has nothing to inject through.
6. **A nullable composite primary key does not enforce uniqueness in SQLite** — reproduced locally: the duplicate insert was accepted and the table held 2 rows. `ability_effect`/`ability_element` are `.nullable()` today.
7. **Tier fallback can contradict explicit data** — dropping to `(name)` may uniquely match a row whose element contradicts the wikitext's own `element=`.
8. **The join-rate gate is measured on the wrong quantity.** A ref can join and still point at a rejected pattern, so extraction could report 92% with zero areas stored.
9. **Enrichment must precede validation, and cannot use `openDb`.** `openDb` is `{ readOnly: true }` and schema-validating: once `mcp_*` is required, validating before enriching rejects the generator's own fresh output.

### Also to fix (non-blocking)

`rotate90=yes` and `input_array` Scenes are real and must be counted-and-discarded; `make-fixture.mjs` would empty the new tables rather than prune them; the 1.5 MB fixture budget has no gate anywhere; 85% vs 90% is stated three times inconsistently; the 7.3% figure describes scene-carrying members, not all abilities; `Retry-After: 2` is 2000 ms; prefer native `headers.get()` over a custom `header()`; requiring `mcp_*` breaks every installed index, so the error must name `build-index`.

### Provenance correction

The spike backs the 92.7% join rate and its buckets, the four-column key, the member-kind dispatch, verbatim `element=`, link collapsing, and tiered matching. It does **not** back the pattern count or the cell semantics — both entered the table unsourced, both are wrong, and both were marked "do not re-derive". `8sqmwave` = 45 cells / width 9 was independently confirmed correct.

### Rejected

- None. Every finding was verified against the repo or the live module before adoption.

## Review 2 — second draft (2026-09-11)

- **Verdict: Needs revision before implementation**
- Reviewers: plan-final-reviewer; codex-consult (high, 36s, 38925 tokens); grok-consult — on request only, not run
- Tier: **single**, upheld again by both reviewers.
- Adopted: none in this stamp — `Needs revision` leaves the body untouched. Findings below are the brief for draft 3.
- **Closure on draft 1's nine:** seven fully closed and independently re-verified against the live module; #7 closed with a wrinkle (supplied-but-empty `element=`); #8 closed for non-empty input only.

### New blocking findings — all verified before adoption

1. **Identity drift — the most serious defect found in either round.** After a fallback tier matches, the *extracted* `(effect, element)` need not equal the *matched row's*, and draft 2 stores the extracted form. Measured full-corpus: tier 1 = 1,055 joins with 0 drift; **tier 2 = 553, all drifted; tier 3 = 141, all drifted — 694 of 1,749 (39.7%)**. Those rows would be written, counted toward a passing 98.8% gate, and return `null` at runtime. Both planned runtime anchors are tier-1, the only tier that cannot drift, so **every test in draft 2 would have passed**. Tenth instance of this repo's signature failure, caught in acceptance criteria rather than code. `SceneRef` must carry the matched row's normalised identity, and a runtime test must anchor on tier 2 or 3.
2. **The "NULL and `''` mean the same thing" row is false, and two tests depend on it.** Confirmed: `effect is null` occurs only with `element` in (`plain_text` 120, `no_template` 6) — prose entries that never carry a scene. Draft 2's NULL tests describe rows that cannot exist, and the Task 5 one would need a hand-inserted fixture row that `make-fixture.mjs` erases on regeneration. Real anchor: The Rootkraken's `Death and Holy AoE`, whose row carries `effect ''` **and** `element ''` and is already in `NAMED_CREATURES`.
3. **Argument trimming unspecified, and the plan's own example hides it.** Real wikitext is `element=fire\n  |scene=…`; ~32% of `|element=` occurrences carry surrounding whitespace. Draft 2's Task 3 test quotes a *flattened* example, so a test written from the plan passes while every real page fails.
4. **The `'?'` default was dropped.** Recorded in the spike addendum but missing from draft 2's per-kind row: an absent damage/range argument maps to `'?'` — 987 rows carry it, 219 of them `Melee`.
5. **`mcp_schema_version` not retained by the fixture builder.** Any table outside `USED`/`keepByType`/`KEEP_WHOLE` is fully emptied; `mcp_ability_area` additionally cannot ride on `keepByType`, which prunes by `article_id` it does not have.
6. **Zero eligible scenes yields `NaN`, and `NaN < 0.95` is false** — the build gate passes on an empty corpus.

### Also to fix

`test/db.test.ts` (seven synthetic schema-only DBs) breaks unless the probe checks columns before row counts; `test/fixture-shape.test.ts`'s `REQUIRED_NON_EMPTY` must gain both tables and host the ungated 1.5 MB budget; fixture regeneration must be ordered enrich → regenerate → tighten probe; page→`creature_id` resolution is unspecified and `Category:Creatures` holds non-creature pages (2,209 members vs 2,193 rows); a rejected `fetch` has no status; assert the User-Agent's contact token, not mere presence; say the Lua fixture is the module verbatim with malformed cases passed inline.

### Corrected overclaim

Addendum 1 said the tiered match "never mis-assigned once across the whole corpus." 0 ambiguous means no *detected* ambiguity — a tier matching exactly one row can still match the wrong one. Corrected in Addendum 2.

### Gate cap reached

This is the second of at most two gate invocations. A third requires the user's say-so.

## Execution authorization (2026-09-11)

Execution began on **draft 3 without a `Ready` stamp**, by explicit user decision:
*"Execute draft 3 now, accepting that its latest fixes are unreviewed."*

The standing rule is that only a `Ready` stamp lets execution start. The user was
told the risk and overrode it knowingly; the gate cap (two invocations, both
`Needs revision`) is what made a third pass their call rather than mine.

**Unreviewed at start of execution:** every draft-3 change — the matched-row identity
rule, argument trimming, the `'?'` default, `mcp_schema_version` retention, the `NaN`
denominator guard, the `db.test.ts` check ordering, the `unparsedMember` counter, and
the scene-count reconciliation. Draft 3's corrections were verified against the repo
and the live wiki as they were written, but no reviewer has seen them as a whole.
