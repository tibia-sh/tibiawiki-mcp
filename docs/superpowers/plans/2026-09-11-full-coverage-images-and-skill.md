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
| Image BLOBs | Every `image` column exists and is 100% empty (`creature.image` 0/2,193). Intentional |
| Generator never fetches animations | `tasks/images.py` builds `titles = [f"{title}{extension}" …]` — exactly one file per article title. A non-skipped build yields `Great Fireball.gif` (icon), never `Great_Fireball_animation.gif`. Un-skipping would not satisfy the image request |
| Image URL retrieval | `action=query&prop=imageinfo&iiprop=url|size`, 50 `File:` titles per request. Measured 0.31 s for 5 titles ⇒ ~280 requests for the full corpus |
| Image host | `https://static.wikia.nocookie.net/tibia/images/<x>/<xy>/<File>/revision/latest?cb=<ts>`. Fandom may transcode to WebP; append `&format=original` to force the original file |
| Spell animations | Player spells carry an uploaded `<Spell>_animation.gif` (e.g. 149,066 bytes, 288×288) discoverable via `prop=images` then `imageinfo`; members of `Category:Spell Animation Images`. Spell wikitext has **no** structured area |
| Area patterns | `Module:SceneBuilder/data` defines **94** keys as `["key"] = {{cells…}, width}`, row-major. `0` unaffected, `1` affected, `2` caster, `3` direction marker. Wiki **text**, CC BY-SA — no CipSoft artwork |
| Area coverage | Sampled 200 creatures: **26%** carry ≥1 scene-tagged ability; 150 such abilities; 39 distinct keys. Extrapolates to ~1,650 abilities corpus-wide |
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
export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
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
- Retries a failed request with backoff a bounded number of times, then throws naming the URL and status. A `maxlag`/`Retry-After` response waits as instructed rather than hammering.
- `fetcher` is injected so every test runs offline against recorded fixtures.

**Tests to write:** batching splits 120 titles into 3 requests; `continue` is followed until absent; a 429 with `Retry-After` is honoured then retried; a persistent failure throws naming URL and status; the User-Agent header is present on every request.

**Acceptance:** `pnpm test` green with **zero** network access in tests (assert the injected fetcher is the only call path).

---

### Task 2: Area patterns — fetch, parse, render

**Why:** This is the capability nothing else offers an agent: the actual shape of an attack. It is also the only image-adjacent data that is unambiguously licensed, being wiki text rather than CipSoft artwork.

**Files:** Create `src/indexer/scene-data.ts`, `src/area.ts`, `test/area.test.ts`; fixture `test/fixtures/scene-data.lua`

**Contract:**
```ts
// src/indexer/scene-data.ts (build time)
export type AreaPattern = { key: string; width: number; cells: number[] };
export function parseSceneData(lua: string): AreaPattern[];
export function fetchSceneData(api: ReturnType<typeof createWikiApi>): Promise<AreaPattern[]>;

// src/area.ts (runtime, no network)
export type Area = { key: string; width: number; height: number; cells: number[]; ascii: string; summary: string };
export function renderArea(p: AreaPattern): Area;
export const AREA_LEGEND: string;   // committed verbatim, explains 0/1/2/3
```

**Behavior:**
- `parseSceneData` reads the `["key"] = {{n,n,…}, width}` form and returns one entry per key. A key whose cell count is not a multiple of its width is **skipped with a warning**, never silently reshaped.
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
- `mcp_ability_area(creature_id INTEGER, ability_name TEXT, pattern_key TEXT, PRIMARY KEY (creature_id, ability_name))`.

**Behavior:**
- **Stores URLs only. Never bytes.** A reviewer must be able to confirm this by grepping for `blob`/`Buffer` in `enrich.ts` and finding nothing.
- Icon URLs are resolved for every entity type that has an image column upstream, by `File:<title><ext>`; unresolved titles are counted in `skipped`, not fatal.
- Animation URLs are resolved for spells via `prop=images` filtered to `_animation.gif`, cross-checked against `Category:Spell Animation Images`.
- Ability→pattern mapping is extracted from creature wikitext by matching the `{{Ability|<name>|…|scene={{Scene|spell=<key>}}}}` shape. A `pattern_key` absent from `mcp_area_pattern` is recorded in `skipped` rather than stored dangling.
- The pass is **idempotent**: re-running replaces rows rather than duplicating, so a partial run can simply be repeated.
- `build-index` runs the generator, then enrichment, then validates, then renames into place — enrichment failure must leave the previous good index untouched exactly as a generator failure does.
- `src/db.ts`'s schema probe gains the three tables; a database built by an older `build-index` must fail the probe with a message naming the missing table and telling the user to rebuild.

**Tests to write:** enrichment against a fixture DB with an injected fetcher creates all three tables with expected row counts; re-running is idempotent (row counts unchanged, no duplicates); an unresolved image title lands in `skipped` without aborting; a dangling pattern key is skipped and reported; **no BLOB is ever written** (assert every `mcp_image.url` is a `https://` string and the table has no blob column); an enrichment failure inside `build-index` leaves a pre-existing index byte-identical.

**Acceptance:** `pnpm test` green. Manual once: a real `build-index` populates ≥10,000 image URLs, 94 patterns, and ≥1,000 ability areas, and `sqlite3` confirms no BLOB columns were added.

---

### Task 4: Expose every entity type through the existing two lookup tools

**Why:** 23 tables are invisible today. The fix is entity types on `tibia_search`/`tibia_get`, not new tools — Anthropic's guidance is that overlapping tools degrade selection, and the measured cliff is 30–50 session-wide, shared with every other server the user runs.

**Files:** Modify `src/domain.ts`, `src/tools/search.ts`, `src/tools/get.ts`, `src/db.ts`; tests `test/entities.test.ts`

**Contract:**
```ts
export const ENTITY_TYPES: readonly ['creature','item','npc','quest','spell',
  'achievement','house','imbuement','charm','mount','outfit','book','world'];
export function entityTable(type: EntityType): string;       // closed map, throws on unknown
export function entityIdColumn(type: EntityType): string;     // closed map
```

**Behavior:**
- `tibia_search` searches all 13 types; its `types` enum and the ordering tiebreak already handle the wider set unchanged.
- `tibia_get`'s discriminated union gains eight members. Each member's fields are enumerated explicitly in the task (not "its own columns") so the schema probe can require exactly them.
- `status` filtering applies to every type that has a `status` column; types without one ignore `include_inactive` and say so in the field description.
- Where an upstream table has no `title` column, the closed identity map names the column that serves as identity; the response still returns it as `title`.

**Tests to write:** `tools/list` still advertises exactly 5 tools; `tibia_search` returns non-empty results for each of the 8 new types; `tibia_get` returns the correct discriminated member for one known entity of each new type, validating against `outputSchema`; a known-answer per type (e.g. a named imbuement's tier, a named house's rent) guards against silent column drift; an entity type with no `status` column does not crash under `include_inactive: true`.

**Acceptance:** `pnpm test` green; the full-index sweep test from `test/regression.test.ts` is extended to page every new type and assert no schema violation.

---

### Task 5: Detail sections — combat, travel, materials, rewards

**Why:** The most glaring gap is combat: today an agent learns a Dragon is fire-immune but not that it casts Great Fireball for 60–140 or hits for 430 total. These are child tables of entities `tibia_get` already returns, so they belong in its detail, not in new tools.

**Files:** Modify `src/tools/get.ts`, `src/db.ts`; tests `test/detail.test.ts`

**Behavior:** `tibia_get` gains, per member:
- **creature** — `abilities[]` from `creature_ability` (name, effect, element) each optionally carrying its `area` from Task 2/3 when `mcp_ability_area` has a mapping; `maxDamage` from `creature_max_damage` (per element plus total); `sounds[]`.
- **item** — `keyInfo` from `item_key`, `storeOffers[]`, `proficiencyPerks[]`, `sounds[]`.
- **npc** — `jobs[]`, `races[]`, `destinations[]` (the travel graph), and buy/sell offer counts with a pointer to `tibia_how_to_obtain` for detail.
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
- Each image is one `resource_link` block: `uri` the wiki URL, `name` `"<title> (<kind>)"`, `mimeType` from the extension, `annotations: { audience: ["user"], priority: 0.3 }`.
- URLs get `&format=original` appended so Fandom serves the original rather than a WebP transcode.
- **No `image` content block, no base64, ever.** A test asserts this directly.
- `IMAGE_ATTRIBUTION` accompanies any response carrying image links and states that Tibia is made by CipSoft and the graphics are copyright CipSoft.
- `structuredContent` carries the same URLs as plain strings so an agent can pass one to a user without parsing content blocks.

**Tests to write:** a creature with an icon yields exactly one `resource_link` with `audience: ["user"]`; no response ever contains a block of `type: 'image'` (assert across every tool on a sample of entities); `format=original` is present on every emitted URL; a spell with an animation yields two links, icon and animation; an entity with no image yields no link and no error.

**Acceptance:** `pnpm test` green; `grep -rn "type: 'image'" src/ --include=*.ts` returns empty.

---

### Task 7: The skill, and packaging it with the server

**Why:** Tool descriptions are always-on context; a skill is one line until invoked. Moving query strategy and domain conventions into a skill lets the tool descriptions shrink while an agent gets *more* guidance, not less.

**Files:** Create `skills/tibiawiki/SKILL.md`, `.claude-plugin/plugin.json`, `.mcp.json`; modify `README.md`, `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md` (§8 no longer defers images/areas), and the five tool descriptions

**Behavior:**
- `SKILL.md` frontmatter carries `name` and a `description` written to trigger on Tibia questions — that description is the only always-on cost.
- Body covers what does **not** belong in tool descriptions: resolve names with `tibia_search` before `tibia_get`; the 100-is-neutral modifier convention; `tibia_how_to_obtain` instead of two lookups; `hitpoints: null` means unrecorded, not zero; `status` and `include_inactive` semantics; how to read an `area` grid; that image links are for the user, not for the model to interpret; the snapshot-not-live caveat with `indexGeneratedAt`.
- Plugin layout per Claude Code's documented structure: components at the **plugin root**, never inside `.claude-plugin/`. `.mcp.json` defines the server; `skills/` holds the skill.
- Tool descriptions are **shortened** by the amount the skill now covers; the task records the before/after byte count of the five descriptions to prove the trade actually happened.

**Tests to write:** `claude plugin validate` passes; the skill file has required frontmatter; the sum of the five tool descriptions is smaller than before this task.

**Acceptance:** `claude --plugin-dir . ` loads the plugin and `/mcp` lists five tools; a fresh `claude -p` session answers a Tibia question using the tools; README documents the plugin install path.

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
