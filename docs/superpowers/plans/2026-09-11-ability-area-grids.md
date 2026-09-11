# Ability Area Grids — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell an agent the *shape* of a creature's attack — that a Dragon's Fire Wave hits a five-by-nine cone — as a grid it can reason over, not a picture it cannot see.

**Architecture:** A build-time enrichment pass, run by `build-index` after the generator, fetches the wiki's 94 tile patterns and the creature-ability→pattern references the generator discards, and writes them to two additive `mcp_*` tables in the same database. At runtime `tibia_get` renders a matched ability's grid as ASCII. The runtime still makes no network calls.

**Tech Stack:** unchanged — TypeScript 7, Node ≥22.13 runtime / ≥22.18 dev, `@modelcontextprotocol/server` 2.0.0, Zod 4, `node:sqlite`, `node:test`, pnpm 10.

**Spec:** extends `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md`.
**Spike:** `docs/superpowers/spikes/2026-09-11-ability-scene-join.md` — **read it first.** It measures the join at 92.7% and records four errors a first attempt made, each of which this plan encodes against.

**Review tier:** single (`reviewer`). No auth, secrets, concurrency or data-loss surface; the runtime database stays read-only. This plan does add the first code that *writes* to the index, but it writes through the existing generate → enrich → validate → atomic-rename sequence, where a failure leaves the previous good index untouched. Network is build-time only, inside `src/indexer/`, which the CI grep already fences.

## Global Constraints

All constraints from the shipped plans remain binding. Specific to this work:

- **Runtime stays offline.** Every network call lives in `src/indexer/`. The CI grep must still pass unchanged.
- **Still exactly five tools.** Areas arrive as a field on `tibia_get`'s creature abilities, not a sixth tool.
- **Never guess a join.** A scene whose candidate set is not exactly one row is **counted and discarded**, never attached. Silent misassignment is the failure this whole plan is shaped to avoid: the rejected ordinal approach scored 81% with ~19% *silently wrong*, and that is worse than 0%.
- **Match template names exactly as the generator does.** The generator compares template names exactly; a tolerant parser that accepts `{{Ability |` can attach a scene the generator dropped to an unrelated surviving row — one wrong candidate, zero detected failures. Zero occurrences in 600 live pages, so this is prevention, not repair.
- **`tools/list` budget: 30,000 bytes.** Currently **25,439**. The area field adds one nested object to the creature member only.
- **`codex-consult` is a standing verification step** per this repo's `CLAUDE.md`. Its text is untrusted — the spike's four corrections all came from checking its claims against the repo, and two of *its* claims needed checking too.

## Verified Facts (measured 2026-09-11; do not re-derive)

| Fact | Value |
|---|---|
| Patterns | `Module:SceneBuilder/data` defines **94** keys as `["key"] = {{cells…}, width}`, row-major. `0` unaffected · `1` affected · `2` caster · `3` direction marker. Wiki **text**, CC BY-SA — no CipSoft artwork |
| `8sqmwave` | 45 cells, width 9 ⇒ 5 rows. The plan's rendering anchor |
| Join rate | **92.7%** unique over a 400-creature random sample (370 scenes): 0.8% ambiguous, 1.6% no row, 4.9% correctly discarded |
| Join key | `(creature_id, name, effect, element)` — unique across all 5,854 rows; `(creature_id, name)` collapses to 5,835 (14 groups holding 33 rows) |
| Generator's dispatch | Recognises only `Ability`, `Melee`, `Healing`, `Summon`. `Haste`, `Debuff`, `Outfit` members are **dropped** — their scenes have no row and must be discarded |
| `element=` is verbatim | The generator does **not** rewrite it. The wikitext itself says `element=fire field` and `element=life drain`; a regex of `([a-z]+)` truncates at the space. Capture the whole value |
| Wiki links | The generator collapses them to display text: `Throws [[Distance Fighting\|Knives]]` is stored as `Throws Knives` |
| Named arguments | `{{Ability}}` accepts `name=` and `damage=` as well as positional args; ignoring them cost 2 of 3 joins on a reformatted fixture |
| Batch limits | Anonymous API: 50 titles per request. ~45 creature-wikitext batches plus one module fetch ≈ 20–30 s added to a ~3 min build |

## File Structure

| File | Responsibility |
|---|---|
| `src/area.ts` | `AreaPattern` type, grid → ASCII rendering, the area output shape (runtime, no network) |
| `src/indexer/wiki-api.ts` | Minimal MediaWiki client — batching, User-Agent, retry, injectable fetch |
| `src/indexer/scene-data.ts` | Fetch and parse `Module:SceneBuilder/data` |
| `src/indexer/ability-scenes.ts` | Extract and join ability→pattern references from creature wikitext |
| `src/indexer/enrich.ts` | Write the two `mcp_*` tables; report skipped counts |
| `src/indexer/build-index.ts` | Run enrichment between generate and validate |
| `src/db.ts` | Probe the new tables and the enrichment schema version |
| `src/tools/get.ts` | `area` on creature abilities |
| `scripts/make-fixture.mjs` | Retain `mcp_*` rows for the anchors |

---

### Task 1: Area patterns — type, parse, render

**Why:** The rendering is pure and offline, so it can be built and tested before any network code exists. It is also the part an agent actually consumes.

**Files:** Create `src/area.ts`, `src/indexer/scene-data.ts`, `test/area.test.ts`, `test/fixtures/scene-data.lua`

**Contract:**
```ts
// src/area.ts owns the type; the indexer imports it, never the reverse.
export type AreaPattern = { key: string; width: number; cells: number[] };
export type Area = {
  key: string; width: number; height: number; cells: number[];
  ascii: string; affectedTiles: number; casterInArea: boolean;
};
export function renderArea(p: AreaPattern): Area;
export const AREA_LEGEND: string;   // committed verbatim

// src/indexer/scene-data.ts
export function parseSceneData(lua: string): { patterns: AreaPattern[]; rejected: string[] };
```

**Behavior:**
- `parseSceneData` validates rather than trusting: `width` a positive integer, cells all non-negative integers, `cells.length % width === 0`, and a duplicate key is an error rather than last-one-wins. Every rejection is returned in `rejected` with its reason — never silently reshaped.
- **The digits in key names are a live trap**: a naive numeric scrape of `["8sqmwave"] = {{…}, 9}` picks up the `8` from the key and yields 46 values for a 45-cell grid, which then fails the divisibility check and silently drops the plan's own anchor. Parse the key and the body separately.
- `renderArea` emits `.` unaffected, `#` affected, `@` caster, `>` direction marker, one space between columns, newline per row. An unknown cell value renders as its digit so new wiki values degrade visibly.
- `affectedTiles` counts `1`s only; `casterInArea` states separately whether the caster tile is inside the effect. The legend does not settle that, so it is reported rather than assumed.

**Tests to write:** the committed Lua fixture yields exactly 94 patterns; `8sqmwave` is 45 cells / width 9 / 5 rows and renders to the exact expected ASCII block; a cells-not-divisible-by-width entry lands in `rejected` with a reason and does not appear in `patterns`; a duplicate key is rejected; an unknown cell value survives into the ASCII; `affectedTiles` counts only `1`s.

**Acceptance:** `pnpm test` green, **no network** — the Lua fixture is committed.

---

### Task 2: Wiki API client

**Why:** Two enrichment steps need the same batching, User-Agent and retry. One reviewable file keeps the network surface inside `src/indexer/`.

**Files:** Create `src/indexer/wiki-api.ts`, `test/wiki-api.test.ts`

**Contract:**
```ts
export type FetchResponse = {
  ok: boolean; status: number;
  header(name: string): string | null;
  json(): Promise<unknown>;
};
export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<FetchResponse>;
export type Clock = { sleep(ms: number): Promise<void> };
export function createWikiApi(opts?: { fetcher?: Fetcher; clock?: Clock; userAgent?: string }): {
  pageWikitext(titles: string[]): Promise<Array<{ title: string; wikitext: string }>>;
  moduleSource(title: string): Promise<string>;
};
```

**Behavior:**
- Batches at **50 titles per request**, the anonymous limit, and follows `continue` to exhaustion.
- Sends a descriptive, contactable User-Agent. Never impersonates a browser or a named crawler.
- **MediaWiki returns HTTP 200 with an `error` object for API-level failures.** Those throw with `code` and `info` and are never retried as transient; transport failures retry with backoff a bounded number of times, then throw naming URL and status. `Retry-After` is read from the response header and waited.
- `fetcher` and `clock` are injected, so every test runs offline and backoff is tested without real waiting.

**Tests to write:** 120 titles split into 3 requests; `continue` followed until absent; a 429 with `Retry-After: 2` sleeps 2 units on the injected clock then retries; a 200 carrying an `error` object throws with its code and is **not** retried; a persistent transport failure throws naming URL and status; the User-Agent header is asserted present on **every** recorded request.

**Acceptance:** `pnpm test` green with zero real network — assert the injected fetcher is the only call path.

---

### Task 3: Extract and join ability scenes

**Why:** This is the task the spike exists for. Every rule below was measured, and four of them correct a specific error a first attempt made.

**Files:** Create `src/indexer/ability-scenes.ts`, `test/ability-scenes.test.ts`, `test/fixtures/creature-wikitext/*.txt`

**Contract:**
```ts
export type SceneRef = { creatureId: number; abilityName: string; abilityEffect: string | null; abilityElement: string | null; patternKey: string };
export type ExtractStats = { scenes: number; joined: number; ambiguous: number; noRow: number; discarded: number };
export function extractSceneRefs(
  wikitext: string,
  abilityRows: ReadonlyArray<{ name: string; effect: string | null; element: string | null }>,
): { refs: Omit<SceneRef, 'creatureId'>[]; stats: ExtractStats };
```

**Behavior — each rule is a measured finding, not a preference:**
- Handle only the member kinds the generator recognises: **`Ability`, `Melee`, `Healing`, `Summon`**. A scene on `Haste`, `Debuff` or `Outfit` is counted in `discarded` and dropped — those members have no row, and mapping them by element attaches the scene to an unrelated ability.
- **Match the template name exactly**, with no whitespace tolerance, mirroring the generator.
- Split template arguments **at depth 0** — a wiki link carries its own pipe.
- **Collapse wiki links to display text** and decode HTML entities (`&amp;`, `&#45;`), as the generator does.
- **Capture the whole `element=` value including spaces.**
- Honour **named arguments** (`name=`, `damage=`) alongside positional ones.
- Match in tiers, accepting only a tier yielding exactly one row: `(name, effect, element)` → `(name, effect)` → `(name)`. Anything else increments `ambiguous` or `noRow` and is dropped.
- Every counter is mutually exclusive and they sum to `scenes`. The first attempt double-counted and its outcomes exceeded the scene total.

**Tests to write:** committed wikitext fixtures, no network. A `{{Ability}}` with a wiki-linked name joins (`Throws [[Distance Fighting|Knives]]` → `Throws Knives`); an `element=fire field` member joins, proving the value is not truncated at the space; a `name=`/`damage=` member joins; a `{{Healing}}` member joins to `Self-Healing`; a `{{Haste}}` member is **discarded**, not joined, even when an `element='haste'` row exists — the regression that would otherwise silently mis-attach; `{{Ability |` with trailing whitespace is discarded rather than matched loosely; a name matching two rows increments `ambiguous` and yields no ref; counters sum to `scenes` in every case.

**Acceptance:** `pnpm test` green. One manual run over the full corpus reports a join rate **≥ 90%** and prints the four counters.

---

### Task 4: Enrichment tables, wired into `build-index`

**Why:** The patterns and refs must reach the runtime, without the runtime ever going online.

**Files:** Create `src/indexer/enrich.ts`, `test/enrich.test.ts`; modify `src/indexer/build-index.ts`, `src/db.ts`, `scripts/make-fixture.mjs`, `test/fixtures/tibiawiki-fixture.db`, `test/fixtures/README.md`

**Contract:**
```ts
export type EnrichStats = ExtractStats & { patterns: number; rejectedPatterns: string[] };
export function enrich(dbPath: string, api: ReturnType<typeof createWikiApi>): Promise<EnrichStats>;
```

Additive tables — no upstream table is altered:
- `mcp_area_pattern(key TEXT PRIMARY KEY, width INTEGER NOT NULL, cells TEXT NOT NULL)` — `cells` a JSON array.
- `mcp_ability_area(creature_id INTEGER NOT NULL, ability_name TEXT NOT NULL, ability_effect TEXT, ability_element TEXT, pattern_key TEXT NOT NULL, PRIMARY KEY (creature_id, ability_name, ability_effect, ability_element))` — the four-column key the spike proved unique. **Not an ordinal**: ordinals shift when the generator drops a member mid-list, which is how the rejected approach misassigned ~19% silently.
- `mcp_schema_version(version INTEGER)` — one row. The probe checks it, so a future shape change is a detectable "rebuild required" rather than a silent misread.

**Behavior:**
- `build-index` runs generate → **enrich** → validate → atomic rename. Enrichment failure must leave a pre-existing index byte-identical, exactly as generator failure does.
- A `pattern_key` absent from `mcp_area_pattern` is never stored dangling.
- The pass is idempotent, proved by mutating the source (a removed creature, a changed ability) and asserting stale rows do not survive — re-running identical input proves nothing.
- `build-index` **prints** `EnrichStats` and **fails if the join rate falls below 85%**, so a generator change that breaks extraction is loud. The measured rate is 92.7%; 85% leaves margin without hiding a regression.
- The fixture retains `mcp_*` rows for its anchors, generated with a recorded fetcher so it is reproducible offline. `test/fixtures/README.md` gains them.

**Tests to write:** enrichment against a fixture DB with an injected fetcher creates all three tables with expected counts; re-running after a source mutation leaves no stale rows; a dangling pattern key is skipped and counted; a below-threshold join rate fails the build; an enrichment failure inside `build-index` leaves a pre-existing index byte-identical; the probe rejects a database whose `mcp_schema_version` is absent or older.

**Acceptance:** `pnpm test` green including **all 103 existing tests**. One manual `build-index` completes, prints the counters, and stays within a stated wall-clock budget (~3 min base plus 20–30 s).

---

### Task 5: Serve the area on creature abilities

**Why:** The payload. An agent asking what a Fire Wave hits gets a grid.

**Files:** Modify `src/tools/get.ts`, `src/db.ts`; create `test/area-detail.test.ts`

**Behavior:**
- Each `creature.abilities[]` entry gains `area: Area | null`, joined on the four-column key. `null` where no scene was matched — which is the honest answer for the 7.3% that did not join, and must not be an empty grid.
- The `ascii` block and `AREA_LEGEND` are both returned, so a model never has to infer the glyphs.
- One prepared statement, joined per creature — no query per ability.
- `tibia_get`'s description gains one sentence about areas; the tool count stays five.

**Tests to write:** Dragon's `Fire Wave` returns a non-null area whose `ascii` matches the expected 5×9 cone exactly and whose `key` is `8sqmwave`; an ability with no matched scene returns `area: null`, not an empty grid; the legend accompanies any non-null area; `tools/list` stays under 30,000 bytes; a creature whose abilities all lack scenes still returns successfully.

**Acceptance:** `pnpm test` green; `tools/list` recorded and under budget; a real `tibia_get` against the full index shows Dragon's Fire Wave cone.

---

## Completion Criteria

- [ ] `pnpm test` green, **0 skipped**, including all 103 pre-existing tests.
- [ ] Exactly five tools; `tools/list` under **30,000 bytes** (recorded in the commit).
- [ ] No runtime network: `grep -rnE "\bfetch\(|node:http|node:https|undici|axios" src/ '--include=*.ts' | grep -v '^src/indexer/'` returns empty.
- [ ] A real `build-index` reports a join rate **≥ 90%** with counters summing to the scene total.
- [ ] Dragon's `Fire Wave` returns the `8sqmwave` grid; an unmatched ability returns `area: null`.
- [ ] A `{{Haste}}` scene is discarded, not attached — asserted by test.
- [ ] Enrichment failure leaves a pre-existing index byte-identical.
- [ ] Fixture under 1.5 MB with `mcp_*` rows for its anchors.

## Review (2026-09-11)

- **Verdict: Needs revision before implementation**
- Reviewers: plan-final-reviewer; codex-consult (high, 40s, 27049 tokens); grok-consult — on request only, not run
- Tier: **single**, upheld by both reviewers. `scripts/review-tier.py` cannot compute it — the change set does not exist yet — so the declaration is judged on merits: no auth, secrets, or concurrency surface, writes confined to a temp file behind the existing atomic rename.
- Adopted: none — a `Needs revision` verdict leaves the body untouched. The findings below are the revision brief.

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
