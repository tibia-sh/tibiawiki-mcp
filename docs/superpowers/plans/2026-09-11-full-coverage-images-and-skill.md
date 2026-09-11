# Full Coverage, Images and Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose everything the index holds, give every entity a human-viewable sprite link and a machine-readable area grid where one exists, and ship a skill that teaches an agent to query all of it well — without growing past five tools.

**Architecture:** `tibiawiki-sql` stays the base generator and its tables stay untouched. A new build-time **enrichment pass** adds three `mcp_*` tables to the same database: image URLs (text, never bytes), the wiki's 94 area patterns, and the creature-ability→pattern mapping. The five existing tools gain entity types and detail sections rather than multiplying.

**Tech Stack:** unchanged — TypeScript 7, Node ≥22.13 runtime / ≥22.18 dev, `@modelcontextprotocol/server@2.0.0`, Zod 4, `node:sqlite`, `node:test`, pnpm 10.

**Spec:** this plan supersedes nothing; it extends `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md`, whose §8 "Out of scope" listed images and resources as deferred. Update that section as part of Task 7.

**Review tier:** single (`reviewer`). No auth, secrets, concurrency or data-loss surface; the database is still opened read-only at runtime. The enrichment pass makes network calls, but only at build time, inside `src/indexer/`, where the existing completion gate already permits them.

## Global Constraints

Inherited from the existing plan and still binding: no runtime network access outside `src/indexer/`; `title` is canonical identity; `status = 'active'` unless `include_inactive`; every SQL fragment from a closed literal map keyed by a validated enum; exact dependency pins older than the 7-day `minimumReleaseAge`; `opus` for every subagent. New constraints for this work:

- **Never store image bytes.** The enrichment pass stores **URLs only**. There is no licence anywhere in the chain permitting redistribution of Tibia sprites: CipSoft's Fansite Agreement grants none, and Fandom's Help:Licensing explicitly excludes uploaded images from the wiki's CC BY-SA. Storing a URL is a reference; shipping a BLOB would make this package the redistributor. `--skip-images` stays on the generator call, permanently.
- **Images are for humans, not the model.** Anthropic's vision documentation states: *"Claude supports JPEG, PNG, GIF, and WebP images. Animations are unsupported, and only the first frame is used."* Image URLs are therefore returned as `resource_link` content with `annotations: { audience: ["user"], priority: 0.3 }` — never as inline `image` blocks and never as base64.
- **Areas are for the model.** Every area is returned as a JSON grid **and** a pre-rendered ASCII block, because that is the form an agent can reason over.
- **Still five tools.** New capability arrives as an entity type, a parameter, or a detail section on an existing tool. Adding a sixth tool requires a stated reason in the task.
- **Attribution unchanged and extended:** the existing CC BY-SA + CipSoft string already ships. Any response carrying an image URL repeats the CipSoft notice in that block.

## Verified Facts (established 2026-09-11; do not re-derive)

| Fact | Value |
|---|---|
| Unexposed data | 23 tables, 27,263 rows. Largest: `creature_ability` 5,854 · `item_proficiency_perk` 4,670 · `creature_sound` 3,683 · `quest_danger` 2,736 · `creature_max_damage` 1,417 · `book` 1,226 · `npc_race` 1,190 · `house` 1,090 · `item_store_offer` 826 · `game_update` 695 · `item_sound` 634 · `achievement` 571 · `world` 292 · `mount` 254 · `npc_destination` 161 · `imbuement_material` 144 · `outfit` 136 · `item_key` 123 · `outfit_quest` 109 · `imbuement` 72 · `charm` 24 · `rashid_position` 7 · `npc_job` 1,349 |
| Image BLOBs | Every **BLOB** `image` column is 100% empty (`creature.image` 0/2,193, all 10 columns). Note `item_proficiency_perk.skill_image` is **TEXT and fully populated** (4,670/4,670) — it is a filename, not a blob, so "all image columns are empty" is true only of BLOBs |
| Generator never fetches animations | `tasks/images.py` builds `titles = [f"{title}{extension}" …]` — exactly one file per article title. A non-skipped build yields `Great Fireball.gif` (icon), never `Great_Fireball_animation.gif`. Un-skipping would not satisfy the image request |
| Image URL retrieval | `action=query&prop=imageinfo&iiprop=url|size`, 50 `File:` titles per request. Measured 0.31 s for 5 titles ⇒ ~280 requests for the full corpus |
| Image host | `https://static.wikia.nocookie.net/tibia/images/<x>/<xy>/<File>/revision/latest?cb=<ts>` |
| `&format=original` | **UNVERIFIED.** The CDN returned 403 to every non-browser request tried (plain, with the parameter, with a WebP `Accept`). Append it, but do not assert it works — the link is opened by a human browser, where it is harmless either way |
| Animation filename form | **The two APIs disagree.** `action=query&prop=images` returns `File:Great Fireball animation.gif` (**spaces**); `action=parse&prop=images` returns `Great_Fireball_animation.gif` (underscores). A filter on `_animation.gif` against the `query` API matches **nothing**. Normalise before filtering. `Category:Spell Animation Images` also holds non-spell files, so it is a weak hint, not a validator |
| Scene template family | Scenes hang off **more than `{{Ability}}`**. A 50-creature sample: `{{Ability}}` ×48, `{{Healing}}` ×5, `{{Debuff}}` ×1. The non-`Ability` forms carry **no name argument** — Dragon's healing scene is `{{Healing|range=40-70|scene={{Scene|spell=buffspell…}}}}` and the database row is `name = 'Self-Healing'`, a generator-derived name |
| Ability-name collisions | `(creature_id, name)` is **NOT unique**: 5,854 rows collapse to 5,835 distinct pairs — 19 rows lost. Creature 66070 has `Ultimate Explosion` ×4; creature 14359 has three distinct `Poison Ball` rows |
| `tools/list` budget | Measured live: **14,149 bytes** total — descriptions 1,296, inputSchemas 4,158, outputSchemas 8,016, of which `tibia_get.outputSchema` alone is **4,992** for 5 union members (~998 bytes/member). 14 members project to ~13 KB, so `tibia_get` alone grows ~8 KB |
| Spell animations | Player spells carry an uploaded `<Spell>_animation.gif` (e.g. 149,066 bytes, 288×288) discoverable via `prop=images` then `imageinfo`; members of `Category:Spell Animation Images`. Spell wikitext has **no** structured area |
| Area patterns | `Module:SceneBuilder/data` defines **94** keys as `["key"] = {{cells…}, width}`, row-major. `0` unaffected, `1` affected, `2` caster, `3` direction marker. Wiki **text**, CC BY-SA — no CipSoft artwork |
| Area coverage | Two independent samples: 200 creatures → 26% with ≥1 scene, 150 scenes; 50 creatures → 34%, 54 scenes. Extrapolates to ~1,650–2,060 corpus-wide, so a ≥1,000 floor carries ~40% headroom |
| Image URL resolvability | 13,799 entities carry an image column; a random 150-title probe (50 items / 50 creatures / 50 NPCs) resolved **150/150**. The ≥10,000 floor is well supported |
| Mapping shape | Creature wikitext: `{{Ability|<name>|<dmg>|element=…|scene={{Scene|spell=<key>|…}}}}`. `tibiawiki-sql`'s `creature_ability` keeps only `name`/`effect`/`element` and **discards the scene key** |

## File Structure

| File | Responsibility |
|---|---|
| `src/indexer/enrich.ts` | Build-time enrichment: populate the three `mcp_*` tables |
| `src/indexer/wiki-api.ts` | Minimal MediaWiki client used only by enrichment (batching, UA, retry) |
| `src/indexer/scene-data.ts` | Fetch + parse `Module:SceneBuilder/data` Lua into patterns |
| `src/area.ts` | Grid → ASCII rendering and the area output shape (runtime, no network) |
| `src/media.ts` | Image-URL → `resource_link` construction, attribution block |
| `src/tools/get.ts` | Extended: 13 entity types, detail sections, areas, image links |
| `src/tools/search.ts` | Extended: the same 13 entity types |
| `src/domain.ts` | Extended: `ENTITY_TYPES`, per-type table/identity maps |
| `src/db.ts` | Extended: schema probe covers the new tables and entity tables |
| `skills/tibiawiki/SKILL.md` | Query strategy and domain conventions for an agent |
| `.claude-plugin/plugin.json`, `.mcp.json` | Plugin packaging so the skill and server ship together |

---

### Task 1: Wiki API client for build-time enrichment

**Why:** Three enrichment steps need the same batching, User-Agent and retry behaviour. Writing it once keeps the network surface in a single reviewable file inside `src/indexer/`, where the no-network completion gate already excludes it.

**Files:** Create `src/indexer/wiki-api.ts`, `test/wiki-api.test.ts`

**Contract:**
```ts
export type WikiPage = { title: string; wikitext: string };
export type ImageInfo = { title: string; url: string; width: number | null; height: number | null; size: number | null };
export type FetchResponse = {
  ok: boolean; status: number;
  header(name: string): string | null;   // Retry-After, etc.
  json(): Promise<unknown>;
};
export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<FetchResponse>;
export function createWikiApi(opts?: { fetcher?: Fetcher; userAgent?: string }): {
  imageInfo(fileTitles: string[]): Promise<ImageInfo[]>;   // batches of 50
  pageWikitext(titles: string[]): Promise<WikiPage[]>;      // batches of 50
  categoryMembers(category: string): Promise<string[]>;     // follows continue
  pageImages(titles: string[]): Promise<Map<string, string[]>>;
};
```

**Behavior:**
- Batches at **50 titles per request** (the anonymous API limit) and follows `continue` tokens to exhaustion.
- Sends a descriptive, contactable User-Agent; never impersonates a browser or a named crawler.
- Retries a failed request with backoff a bounded number of times, then throws naming the URL and status. `Retry-After` is read from the response header and waited as instructed rather than hammering.
- **MediaWiki returns HTTP 200 with an `error` object for API-level failures.** These are distinguished from transport failures: an API error is thrown with its `code` and `info`, never retried as if transient.
- The clock is injectable so backoff is testable without real waiting.
- `fetcher` is injected so every test runs offline against recorded fixtures.

**Tests to write:** batching splits 120 titles into 3 requests; `continue` is followed until absent; a 429 with `Retry-After: 2` waits 2 units on the injected clock then retries; a 200 carrying an `error` object throws with its `code` and is **not** retried; a persistent transport failure throws naming URL and status; **the User-Agent header is asserted present on every recorded request** (the injected fetcher records `init.headers`).

**Acceptance:** `pnpm test` green with **zero** network access in tests (assert the injected fetcher is the only call path).

---

### Task 2: Area patterns — fetch, parse, render

**Why:** This is the capability nothing else offers an agent: the actual shape of an attack. It is also the only image-adjacent data that is unambiguously licensed, being wiki text rather than CipSoft artwork.

**Files:** Create `src/indexer/scene-data.ts`, `src/area.ts`, `test/area.test.ts`; fixture `test/fixtures/scene-data.lua`

**Contract:**
```ts
// src/area.ts owns the type; the indexer imports it, never the reverse -
// a runtime module must not import from src/indexer/.
export type AreaPattern = { key: string; width: number; cells: number[] };

// src/indexer/scene-data.ts (build time)
export function parseSceneData(lua: string): AreaPattern[];
export function fetchSceneData(api: ReturnType<typeof createWikiApi>): Promise<AreaPattern[]>;

// src/area.ts (runtime, no network)
export type Area = { key: string; width: number; height: number; cells: number[]; ascii: string; summary: string };
export function renderArea(p: AreaPattern): Area;
export const AREA_LEGEND: string;   // committed verbatim, explains 0/1/2/3
```

**Behavior:**
- `parseSceneData` reads the `["key"] = {{n,n,…}, width}` form and returns one entry per key. Validation is explicit, not just divisibility: `width` must be a positive integer, cells must all be non-negative integers, cell count must be an exact multiple of `width`, and a duplicate key is an error rather than a last-one-wins overwrite. Every rejection is reported with the key and the reason, never silently reshaped.
- Whether the caster tile (`2`) also counts as affected is **not** derivable from the legend, so `summary` states the affected count excluding the caster and names the caster separately rather than guessing.
- `renderArea` produces `ascii` using the legend `.` unaffected, `#` affected, `@` caster, `>` direction marker, one space between columns, newline per row.
- `summary` is a short derived sentence an agent can use without parsing the grid — affected tile count, grid dimensions, and whether the caster is inside the affected set.
- Unknown cell values are rendered as their digit rather than dropped, so new wiki values degrade visibly.

**Tests to write:** the committed Lua fixture parses to the expected key count; `8sqmwave` renders to the exact expected 5×9 ASCII block; a malformed entry (cells not divisible by width) is skipped and reported; `summary` counts affected tiles correctly; an unknown cell value survives into the output.

**Acceptance:** `pnpm test` green; the fixture is committed so this task needs no network.

---

### Task 3: Enrichment pass — the three `mcp_*` tables

**Why:** Image URLs, area patterns and the ability→pattern mapping are all data `tibiawiki-sql` does not produce. Adding them in a separate pass keeps the upstream schema untouched and makes provenance obvious at a glance.

**Files:** Create `src/indexer/enrich.ts`, `test/enrich.test.ts`; modify `src/indexer/build-index.ts`, `src/db.ts`

**Contract:**
```ts
export type EnrichStats = { imageUrls: number; patterns: number; abilityAreas: number; skipped: string[] };
export function enrich(dbPath: string, api: ReturnType<typeof createWikiApi>): Promise<EnrichStats>;
```

Tables created by the pass (all additive; no upstream table is altered):
- `mcp_image(entity_type TEXT, article_id INTEGER, kind TEXT, file_title TEXT, url TEXT, width INTEGER, height INTEGER, PRIMARY KEY (entity_type, article_id, kind))` — `kind` is `'icon'` or `'animation'`.
- `mcp_area_pattern(key TEXT PRIMARY KEY, width INTEGER, cells TEXT)` — `cells` is a JSON array.
- `mcp_ability_area(creature_id INTEGER, ability_ordinal INTEGER, ability_name TEXT, pattern_key TEXT, PRIMARY KEY (creature_id, ability_ordinal))` — keyed by **ordinal, not name**. `(creature_id, name)` is not unique: 5,854 `creature_ability` rows collapse to 5,835 distinct pairs, so a name key silently loses 19 rows. `ability_ordinal` is the zero-based position of the ability within that creature's wikitext ability list, which is the same order `tibiawiki-sql` inserts its rows in.

**Behavior:**
- **Stores URLs only. Never bytes.** A reviewer must be able to confirm this by grepping for `blob`/`Buffer` in `enrich.ts` and finding nothing.
- Icon URLs are resolved for every entity type that has an image column upstream, by `File:<title><ext>`; unresolved titles are counted in `skipped`, not fatal.
- Animation URLs are resolved for spells via `prop=images` filtered to `_animation.gif`, cross-checked against `Category:Spell Animation Images`.
- Ability→pattern mapping is extracted from creature wikitext across the **whole template family that can carry a scene** — `{{Ability}}`, `{{Healing}}`, `{{Debuff}}`, `{{Melee}}`, `{{Summon}}`. Matching only `{{Ability}}` is insufficient and would miss the plan's own Dragon acceptance case, whose healing scene is `{{Healing|range=40-70|scene={{Scene|spell=buffspell…}}}}`.
- **Name derivation is the hard part and must be explicit.** `{{Ability}}` carries its name as the first positional argument; `{{Healing}}`, `{{Melee}}` and the rest carry **none**, and the database row holds a generator-derived name (`Self-Healing`, `Melee`). The enrichment maps by **position within the ability list** rather than by reproducing that derivation, which is why the key is an ordinal.
- Every unmatched ability, unknown `pattern_key`, or ordinal that does not line up with a `creature_ability` row is counted in `skipped` and **never stored dangling**. `EnrichStats.skipped` is not merely returned: `build-index` prints it and **fails if the unmatched rate exceeds a stated ceiling**, so a future generator change that breaks the join is loud rather than silent.
- The pass is **idempotent**, and idempotence is proved by more than re-running identical input: a test mutates the source (a removed entity, a changed image title) and asserts stale enrichment rows do **not** survive.
- `mcp_schema_version` carries a single integer row. The probe checks it, so a future semantic change to the `mcp_*` shape is detectable as "rebuild required" rather than silently misread — the same precedent `REQUIRED_INFO_KEYS` already sets over `database_info`.
- `build-index` runs the generator, then enrichment, then validates, then renames into place — enrichment failure must leave the previous good index untouched exactly as a generator failure does.
- `src/db.ts`'s schema probe gains the three tables; a database built by an older `build-index` must fail the probe with a message naming the missing table and telling the user to rebuild.

**Tests to write:** enrichment against a fixture DB with an injected fetcher creates all three tables with expected row counts; re-running is idempotent (row counts unchanged, no duplicates); an unresolved image title lands in `skipped` without aborting; a dangling pattern key is skipped and reported; **no BLOB is ever written** (assert every `mcp_image.url` is a `https://` string and the table has no blob column); an enrichment failure inside `build-index` leaves a pre-existing index byte-identical.

**Fixture regeneration is part of this task, not a later surprise.** The committed fixture has **0 rows** in every table Tasks 4–5 need (`creature_ability`, `creature_max_damage`, `npc_destination`, `imbuement`, `house`, `achievement`, `book`, `charm`, `mount`, `outfit`, `world`, `quest_danger`, `item_key`, …) and **no `mcp_*` tables at all** — so the moment the probe requires them, all 71 existing tests fail. This task must therefore also:
- extend `scripts/make-fixture.mjs` retention to every table Tasks 4–5 query, plus the three `mcp_*` tables, keeping the fixture under its size budget;
- run enrichment against the fixture with a **recorded** fetcher so the fixture's `mcp_*` rows are reproducible offline;
- regenerate and recommit `test/fixtures/tibiawiki-fixture.db`;
- update `test/fixtures/README.md`, whose claims "Tables no tool queries are emptied" and "No images are included" both stop being true.

**Acceptance:**
- `pnpm test` green — **including all 71 pre-existing tests**, which is the real gate on this task.
- Manual once: a real `build-index` populates ≥10,000 image URLs, 94 patterns and ≥1,000 ability areas, prints `EnrichStats.skipped`, and stays within a stated wall-clock budget (the base generate is ~3 min; enrichment adds ~280 image requests, ~45 creature-wikitext batches and the spell lookups, so state the budget and fail past it).
- A row-level assertion, not a grep, proves the no-bytes rule: every `mcp_image.url` is an `https://` string and `pragma table_info(mcp_image)` reports no BLOB column.

---

### Task 4: Expose every entity type through the existing two lookup tools

**Why:** 23 tables are invisible today. The fix is entity types on `tibia_search`/`tibia_get`, not new tools — Anthropic's guidance is that overlapping tools degrade selection, and the measured cliff is 30–50 session-wide, shared with every other server the user runs.

**Files:** Modify `src/domain.ts`, `src/tools/search.ts`, `src/tools/get.ts`, `src/db.ts`; tests `test/entities.test.ts`

**Contract:**
```ts
export const ENTITY_TYPES: readonly ['creature','item','npc','quest','spell',
  'achievement','house','imbuement','charm','mount','outfit','book','world','update'];
export function entityTable(type: EntityType): string;       // closed map, throws on unknown
export function entityIdColumn(type: EntityType): string;     // closed map
```

**Behavior:**
- `tibia_search` searches all 13 types; its `types` enum and the ordering tiebreak already handle the wider set unchanged.
- `tibia_get`'s discriminated union gains **nine** members, enumerated here exactly — column lists verified against the real index on 2026-09-11. "Its own columns" is not a contract; the previous plan was rejected twice for that phrasing and this is the enumeration:
  - **achievement** — `title, grade, points, description, spoiler, is_secret, is_premium, achievement_id, status`
  - **house** — `title, house_id, city, street, location, beds, rent, size, rooms, floors, x, y, z, is_guildhall, status`
  - **imbuement** — `title, tier, type, category, effect, slots, status` + `materials[]`
  - **charm** — `title, type, effect, cost_level_1, cost_level_2, cost_level_3, status`
  - **mount** — `title, speed, taming_method, is_buyable, price, achievement, light_color, light_radius, status`
  - **outfit** — `title, outfit_type, is_premium, is_bought, is_tournament, full_price, achievement, status` + `quests[]`
  - **book** — `title, book_type, item_id, location, blurb, author, prev_book, next_book, status` (+ `text` only at `verbosity: 'detailed'`)
  - **world** — `title, location, pvp_type, is_preview, is_experimental, online_since, offline_since, merged_into, battleye, battleye_type, protected_since, world_board, trade_board` — **no `status` column**
  - **update** (`game_update`) — `title, release_date, news_id, type_primary, type_secondary, previous, next, summary, changes` — **no `status` column**
  Every scalar is nullable unless the fixture proves otherwise.
- `status` filtering applies only to types that **have** a `status` column. `world` and `update` do not; for them `include_inactive` is a no-op, stated in the field description and covered by a test. The current `tibia_search` applies `statusClause` unconditionally, so `entityTable` gains a companion `entityHasStatus(type): boolean` and the query is built accordingly — otherwise those two types raise `no such column: status`.
- **`rashid_position` has neither `title` nor `article_id`** — it is 7 rows keyed by `day`, so it is not an entity. It is routed as a `rashidSchedule[]` detail on the NPC `Rashid` in Task 5, which is where a player would look. That closes the last unrouted table: with `update` above, all 23 now have a destination.
- Where an upstream table has no `title` column, the closed identity map names the column that serves as identity; the response still returns it as `title`.

**Tests to write:** `tools/list` still advertises exactly 5 tools; `tibia_search` returns non-empty results for each of the 9 new types; `world` and `update` resolve under both `include_inactive` settings without raising `no such column: status`; `tibia_get` returns the correct discriminated member for one known entity of each new type, validating against `outputSchema`; a known-answer per type (e.g. a named imbuement's tier, a named house's rent) guards against silent column drift; an entity type with no `status` column does not crash under `include_inactive: true`.

**Acceptance:**
- `pnpm test` green.
- The sweep in `test/regression.test.ts` is extended to call **`tibia_get` on every entity it discovers**, not just page `tibia_find_items`, since the new detail schemas are what can break.
- **The sweep must stop being CI-invisible.** It is currently `{ skip: !existsSync(FULL_DB) }` against a gitignored database, so it has never run on a pull request and would silently rot. Either point it at the committed fixture (which after Task 3 holds rows for every type) or add a CI step that builds an index — state which, and assert the suite reports **0 skipped** so a skip cannot hide.

---

### Task 5: Detail sections — combat, travel, materials, rewards

**Why:** The most glaring gap is combat: today an agent learns a Dragon is fire-immune but not that it casts Great Fireball for 60–140 or hits for 430 total. These are child tables of entities `tibia_get` already returns, so they belong in its detail, not in new tools.

**Files:** Modify `src/tools/get.ts`, `src/db.ts`; tests `test/detail.test.ts`

**Behavior:** `tibia_get` gains, per member:
- **creature** — `abilities[]` from `creature_ability` (name, effect, element) each optionally carrying its `area` from Task 2/3 when `mcp_ability_area` has a mapping; `maxDamage` from `creature_max_damage` (per element plus total); `sounds[]`.
- **item** — `keyInfo` from `item_key`, `storeOffers[]`, `proficiencyPerks[]`, `sounds[]`.
- **npc** — `jobs[]`, `races[]`, `destinations[]` (the travel graph), buy/sell offer counts with a pointer to `tibia_how_to_obtain`, and — for `Rashid` only — `rashidSchedule[]` from `rashid_position` (day, city, location, x/y/z).
- **quest** — `dangers[]`, `rewards[]`.
- **imbuement** — `materials[]`.
- **outfit** — `quests[]`.
- Prose-heavy sections (`book.text`, long `legend`) appear only at `verbosity: 'detailed'`, keeping the concise default cheap.

**Tests to write:** Dragon returns 4 abilities including `Great Fireball` with effect `60-140` and element `fire`; Dragon's `maxDamage.fire` is 310 and `total` 430; an ability with a scene mapping carries a non-empty `area.ascii`; an ability without one carries `area: null` rather than an empty grid; an NPC with destinations returns them; concise verbosity omits `book.text` while detailed includes it.

**Acceptance:** `pnpm test` green with the Dragon known-answers asserted exactly.

---

### Task 6: Image links and area output in tool responses

**Why:** The user asked for sprites to be viewable. The correct vehicle is a link with an explicit human audience — it satisfies the request, costs ~30 tokens, and keeps this package a referrer rather than a redistributor.

**Files:** Create `src/media.ts`, `test/media.test.ts`; modify `src/tools/get.ts`

**Contract:**
```ts
export type ImageRef = { kind: 'icon' | 'animation'; url: string; width: number | null; height: number | null };
export function imageResourceLinks(refs: ImageRef[], title: string): ContentBlock[];
export const IMAGE_ATTRIBUTION: string;   // committed verbatim, names CipSoft
```

**Behavior:**
- Each image is one `resource_link` block: `uri` the wiki URL, `name` `"<title> (<kind>)"`, `mimeType` derived from the **file title's** extension — not the URL's, whose pathname ends `/revision/latest` and carries no usable extension — and `annotations: { audience: ["user"], priority: 0.3 }`. That annotation is a **presentation hint**: it tells a host who the block is for and does not stop a model reading the URL string. What makes this safe is that these are links rather than pixels, not the annotation.
- URLs get `&format=original` appended so Fandom serves the original rather than a WebP transcode.
- **No `image` content block, no base64, ever.** A test asserts this directly.
- `IMAGE_ATTRIBUTION` accompanies any response carrying image links and states that Tibia is made by CipSoft and the graphics are copyright CipSoft.
- `structuredContent` carries the same URLs as plain strings so an agent can pass one to a user without parsing content blocks.

**Tests to write:** a creature with an icon yields exactly one `resource_link` with `audience: ["user"]`; no response ever contains a block of `type: 'image'` (assert across every tool on a sample of entities); `format=original` is present on every emitted URL; a spell with an animation yields two links, icon and animation; an entity with no image yields no link and no error.

**Acceptance:** `pnpm test` green. The **enforcement is the runtime assertions**, not the grep: no response across a sampled sweep of every entity type contains a block of `type: 'image'`, and every emitted URL is an `https://` string. The greps in the Completion Criteria are belt-and-braces only — as originally written they were partly theatre, since `blob` also matches an explanatory comment saying "never store BLOBs", and `type: 'image'` misses the double-quoted spelling.

---

### Task 7: The skill, and packaging it with the server

**Why:** Tool descriptions are always-on context; a skill is one line until invoked. Moving query strategy and domain conventions into a skill lets the tool descriptions shrink while an agent gets *more* guidance, not less.

**Files:** Create `skills/tibiawiki/SKILL.md`, `.claude-plugin/plugin.json`, `.mcp.json`; modify `README.md`, `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md` (§8 no longer defers images/areas), and the five tool descriptions

**Behavior:**
- `SKILL.md` frontmatter carries `name` and a `description` written to trigger on Tibia questions — that description is the only always-on cost.
- Body covers what does **not** belong in tool descriptions: resolve names with `tibia_search` before `tibia_get`; the 100-is-neutral modifier convention; `tibia_how_to_obtain` instead of two lookups; `hitpoints: null` means unrecorded, not zero; `status` and `include_inactive` semantics; how to read an `area` grid; that image links are for the user, not for the model to interpret; the snapshot-not-live caveat with `indexGeneratedAt`.
- Plugin layout per Claude Code's documented structure: components at the **plugin root**, never inside `.claude-plugin/`. `.mcp.json` defines the server; `skills/` holds the skill.
- Tool descriptions are shortened by the amount the skill now covers — but **the gate is `tools/list` total bytes, not description bytes.** Measured today: 14,149 total, of which descriptions are only 1,296 while `outputSchemas` are 8,016 (`tibia_get` alone 4,992 for 5 members ≈ 998 b/member). Tasks 4–5 take that union to 14 members, roughly +8 KB, so trimming descriptions can offset at most 1.3 KB of it. State a `tools/list` byte budget and assert against it; a smaller description total alone proves nothing.
- The skill must **not** be the only place correctness-critical guidance lives: clients that never load a Claude skill still need enough in the tool descriptions to call them correctly. Move *strategy* to the skill; keep *semantics* (what a null hitpoints means, what `weak_to` compares) in the descriptions.
- **Packaging reach:** `package.json` has `files: ["dist"]`, so `skills/`, `.claude-plugin/` and `.mcp.json` never reach the npm tarball. Either extend `files` or state plainly that plugin distribution is git/marketplace-only and npm ships the bare server.

**Tests to write (automated):** the skill file parses and has the required frontmatter fields; `tools/list` total bytes is within the stated budget.

**Manual gates (explicitly not `node:test`):** `claude plugin validate` passes; `claude --plugin-dir .` loads the plugin and `/mcp` lists five tools; a fresh `claude -p` session answers a Tibia question. The last is non-deterministic — a correct answer does not prove the skill was loaded, so evidence must be the observable tool calls plus the skill appearing in that session's context, not the answer text. If any of these move into CI, that workflow edit independently triggers `github-actions-security-hardening` per CLAUDE.md.

---

## Completion Criteria

- [ ] `pnpm test` green, no skipped tests.
- [ ] Still exactly five tools: `npx … --method tools/list` returns 5.
- [ ] All 13 entity types resolvable through `tibia_search` and `tibia_get`.
- [ ] `grep -rniE "blob|Buffer\.from" src/indexer/enrich.ts` returns empty — URLs only, never bytes.
- [ ] `grep -rn "type: 'image'" src/ --include=*.ts` returns empty — links only, never inline images.
- [ ] No runtime network outside the indexer: `grep -rnE "\bfetch\(|node:http|node:https|undici|axios" src/ '--include=*.ts' | grep -v '^src/indexer/'` returns empty.
- [ ] A real `build-index` produces ≥10,000 image URLs, 94 area patterns and ≥1,000 ability areas.
- [ ] Dragon's `Great Fireball` ability returns an ASCII area grid.
- [ ] `claude plugin validate` passes and a fresh `claude -p` session answers using the skill plus tools.
