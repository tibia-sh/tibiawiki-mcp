# Expose Everything, and Ship a Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every row the index already holds reachable through the existing five tools, and ship a skill that teaches an agent to query them well.

**Architecture:** Nothing new is built. All 27,263 currently-unexposed rows are **already in the database**; they need no enrichment pass, no wiki API client and no network. The work is entity types, detail sections, a regenerated fixture and a skill.

**Tech Stack:** unchanged — TypeScript 7, Node ≥22.13 runtime / ≥22.18 dev, `@modelcontextprotocol/server@2.0.0`, Zod 4, `node:sqlite`, `node:test`, pnpm 10.

**Spec:** extends `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md`.

**Origin:** this is **Plan A** of the three-way split recorded in the round-2 stamp of `2026-09-11-full-coverage-images-and-skill.md`. Image links (Plan B) and area grids (Plan C) are deliberately excluded — Plan C's ability→scene join is an unsolved problem that failed two gate rounds and needs a spike first. Do not reintroduce either here.

**Review tier:** single (`reviewer`). Confirmed correct by both reviewers across two gate rounds on the parent plan: no auth, secrets, concurrency or data-loss surface; the runtime database stays read-only; and this plan adds **no network access at all**, so the CI grep boundary is untouched.

## Global Constraints

All constraints from the shipped plan remain binding. Specific to this work:

- **No new network access.** This plan touches nothing under `src/indexer/`. The CI grep that forbids runtime networking must still pass unchanged.
- **Still exactly five tools.** New capability arrives as an entity type, a parameter or a detail section.
- **`tools/list` byte budget: 30,000.** Measured today: **14,149** total (descriptions 1,296 · inputSchemas 4,158 · outputSchemas 8,016, of which `tibia_get.outputSchema` is 4,992 for five union members ≈ 998 b/member). Fourteen members project to ~13 KB, and Task 3's detail arrays grow the five existing members too — the parent plan's "+8 KB" estimate ignored that and was optimistic. 30,000 leaves room for both while staying an order below Claude Code's 25,000-**token** MCP output cap. The number is stated here, not deferred to implementation.
- **Fixture budget: 1.5 MB** (897 KB today). Retention is by **named rows**, matching the existing `NAMED_CREATURES`/`NAMED_ITEMS` shape — not "keep the table". The heavy columns are `book.text` (1,226 rows) and `game_update.changes`/`summary` (695).
- **`codex-consult` is a standing verification step** per this repo's `CLAUDE.md`, not only at the gate. Treat its output as untrusted and check each claim against the repo.
- Attribution, `title`-as-identity, active-by-default status filtering and the closed-map SQL rule all carry over unchanged.

## Verified Facts (measured 2026-09-11; do not re-derive)

| Fact | Value |
|---|---|
| Everything needed is already present | All 23 unexposed tables / **27,263 rows** live in the generated index. This plan adds no data |
| Nine new union members, columns verified to exist | **achievement** `title, grade, points, description, spoiler, is_secret, is_premium, achievement_id, status` · **house** `title, house_id, city, street, location, beds, rent, size, rooms, floors, x, y, z, is_guildhall, status` · **imbuement** `title, tier, type, category, effect, slots, status` · **charm** `title, type, effect, cost_level_1..3, status` · **mount** `title, speed, taming_method, is_buyable, price, achievement, light_color, light_radius, status` · **outfit** `title, outfit_type, is_premium, is_bought, is_tournament, full_price, achievement, status` · **book** `title, book_type, item_id, location, blurb, author, prev_book, next_book, status` (+`text` at detailed) · **world** `title, location, pvp_type, is_preview, is_experimental, online_since, offline_since, merged_into, battleye, battleye_type, protected_since, world_board, trade_board` · **update** (`game_update`) `title, release_date, news_id, type_primary, type_secondary, previous, next, summary, changes` |
| Two types have **no** `status` column | `world` and `game_update`. Both `tibia_search` **and** `tibia_get` currently apply `statusClause` unconditionally, so both raise `no such column: status` on these types unless made conditional |
| `rashid_position` is not an entity | 7 rows, columns `day, city, location, x, y, z` — no `title`, no `article_id`. Routed as NPC detail on `Rashid` |
| `creature_ability` composite key | `(creature_id, name, effect, element)` is **unique across all 5,854 rows**; `(creature_id, name)` collapses to 5,835. Read-side ordering must not rely on implicit `rowid` — `make-fixture.mjs` runs `VACUUM`, which may renumber rowids |
| Fixture is empty for every new table | The committed fixture has **0 rows** in `creature_ability`, `creature_max_damage`, `npc_destination`, `imbuement*`, `house`, `achievement`, `book`, `charm`, `mount`, `outfit`, `world`, `game_update`, `quest_danger`, `item_key`, `npc_job`, `npc_race`, `item_store_offer`, `item_proficiency_perk`, `*_sound`, `outfit_quest` |
| Dragon known-answers | 4 abilities incl. `Great Fireball` `60-140` fire; `creature_max_damage` physical 120 / fire 310 / total 430 |
| `tools/list` today | 14,149 bytes over 5 tools |

## File Structure

| File | Responsibility |
|---|---|
| `scripts/make-fixture.mjs` | Extended retention for the new tables, by named rows |
| `src/domain.ts` | `ENTITY_TYPES` 5→14; `entityTable`/`entityIdColumn`/`entityHasStatus` **replacing** `searchTable` |
| `src/tools/search.ts` | Search across 14 types; conditional status |
| `src/tools/get.ts` | Nine new union members; detail sections; conditional status |
| `src/db.ts` | Schema probe covers every table the tools now read |
| `skills/tibiawiki/SKILL.md` | Query strategy and domain conventions |
| `.claude-plugin/plugin.json`, `.mcp.json` | Plugin packaging |

---

### Task 1: Regenerate the fixture with the tables every later task needs

**Why:** Tasks 2 and 3 assert against tables the committed fixture has zero rows in. Without this first, every one of their tests passes vacuously or fails outright — the exact trap that shipped two real bugs in this repo already.

**Files:** Modify `scripts/make-fixture.mjs`, `test/fixtures/tibiawiki-fixture.db`, `test/fixtures/README.md`

**Contract:** no new exports. `make-fixture.mjs` gains named-row retention constants per new entity type, mirroring `NAMED_CREATURES`.

**Behavior:**
- Retain, by **name**, at least one row per new entity type plus its child rows: an achievement, a house, an imbuement with materials, a charm, a mount, an outfit with quests, a book (with `text`), a world, a game update, plus `rashid_position` in full (7 rows).
- Retain child rows for creatures and items already in the fixture: `creature_ability`, `creature_max_damage`, `creature_sound`, `item_key`, `item_sound`, `item_store_offer`, `item_proficiency_perk`, `npc_job`, `npc_race`, `npc_destination`, `quest_danger`, `outfit_quest`.
- **Retain `Dragon`'s abilities specifically**, since Task 3's known-answer test asserts `Great Fireball` `60-140`.
- Retain a creature with a **duplicate ability name** (creature 14359 has three `Poison Ball` rows) so the composite-key behaviour has an anchor.
- The existing `pragma foreign_key_check` orphan sweep still runs and must still report clean.
- Update `test/fixtures/README.md`: its claims "Tables no tool queries are emptied" and the 1 MB rationale both change.

**Tests to write:** a fixture-shape test asserting ≥1 row in every table Tasks 2–3 query, naming each table, so a future trim cannot silently empty one; the duplicate-ability creature is present; `Dragon` has 4 abilities.

**Acceptance:**
- `node scripts/make-fixture.mjs data/tibiawiki.db test/fixtures/tibiawiki-fixture.db` writes a file **under 1.5 MB** and reports referential integrity clean.
- `pnpm test` green — **all 71 existing tests still pass**, which is the real gate here.

---

### Task 2: Fourteen entity types, one identity map, conditional status

**Why:** 23 tables are unreachable. Types on the two lookup tools beat eight new tools: the measured selection cliff is 30–50 tools session-wide and is shared with every other server the user runs.

**Files:** Modify `src/domain.ts`, `src/tools/search.ts`, `src/tools/get.ts`, `src/db.ts`; create `test/entities.test.ts`

**Contract:**
```ts
export const ENTITY_TYPES: readonly ['creature','item','npc','quest','spell',
  'achievement','house','imbuement','charm','mount','outfit','book','world','update'];
export function entityTable(type: EntityType): string;        // closed map, throws on unknown
export function entityIdColumn(type: EntityType): string;      // closed map
export function entityHasStatus(type: EntityType): boolean;    // false for 'world' and 'update'
// `searchTable` is REPLACED by `entityTable` and deleted — no duplicate path survives.
```

**Behavior:**
- `tibia_search` and `tibia_get` both accept all 14 types. `tibia_get`'s union gains the nine members enumerated in Verified Facts, with those exact columns.
- **Status filtering becomes conditional in both tools.** Today each applies `statusClause` unconditionally; for `world` and `update` that raises `no such column: status`. Where `entityHasStatus(type)` is false, the clause is omitted and `include_inactive` is documented as a no-op for that type.
- Scalar nullability is taken from the upstream column definition, not inferred from whichever rows the fixture happens to hold.
- `src/db.ts`'s probe covers every table now read.

**Tests to write:** `tools/list` still advertises exactly 5 tools; `tibia_search` returns non-empty results for each of the 9 new types; `tibia_get` returns the correct discriminated member for one named entity of each new type and validates against `outputSchema`; `world` and `update` resolve under **both** `include_inactive` values without raising `no such column`; one known-answer per new type (a named imbuement's tier, a named house's rent) guards silent column drift; `entityTable`/`entityIdColumn`/`entityHasStatus` each reject an out-of-enum key.

**Acceptance:** `pnpm test` green; `grep -rn 'searchTable' src/` returns empty (the old map is gone, not shadowed); `tools/list` total bytes recorded and **under 30,000**.

---

### Task 3: Detail sections — combat, travel, materials, rewards

**Why:** The most glaring gap. Today an agent learns a Dragon is fire-immune but not that it casts Great Fireball for 60–140 or hits for 430 total. These are child tables of entities `tibia_get` already returns.

**Files:** Modify `src/tools/get.ts`, `src/db.ts`; create `test/detail.test.ts`

**Behavior:** per union member —
- **creature** — `abilities[]` from `creature_ability` (`name`, `effect`, `element`); `maxDamage` from `creature_max_damage` (per element plus `total`); `sounds[]`. **No `area` field** — that is Plan C and must not be stubbed in here.
- **item** — `keyInfo`, `storeOffers[]`, `proficiencyPerks[]`, `sounds[]`.
- **npc** — `jobs[]`, `races[]`, `destinations[]`; and for `Rashid` only, `rashidSchedule[]` from `rashid_position` (`day, city, location, x, y, z`).
- **quest** — `dangers[]`, `rewards[]`.
- **imbuement** — `materials[]`. **outfit** — `quests[]`.
- Rows are read with an explicit `ORDER BY` on real columns — **never implicit `rowid` order**, since `make-fixture.mjs` runs `VACUUM` and SQLite may renumber rowids for tables without an INTEGER PRIMARY KEY.
- Prose-heavy fields (`book.text`, long `legend`) appear only at `verbosity: 'detailed'`.

**Tests to write:** Dragon returns 4 abilities including `Great Fireball` / `60-140` / `fire`; Dragon's `maxDamage.fire` is 310 and `total` 430; the duplicate-ability creature returns **all three** `Poison Ball` rows, not one (guards any accidental de-duplication by name); an NPC with destinations returns them; `Rashid` returns a 7-entry schedule; concise omits `book.text` while detailed includes it; an entity whose child table is empty returns `[]` rather than null or an error.

**Acceptance:** `pnpm test` green with the Dragon known-answers asserted exactly; `tools/list` re-recorded and still under 30,000.

---

### Task 4: The skill, packaged with the server

**Why:** Tool descriptions are always-on context; a skill is one line until invoked. Moving *strategy* to a skill lets descriptions carry only *semantics*.

**Files:** Create `skills/tibiawiki/SKILL.md`, `.claude-plugin/plugin.json`, `.mcp.json`; modify `README.md`, `package.json`

**Behavior:**
- Skill body carries what does not belong in always-on descriptions: resolve names with `tibia_search` before `tibia_get`; the 100-is-neutral modifier convention; prefer `tibia_how_to_obtain` over two lookups; `hitpoints: null` means unrecorded, not zero; `status`/`include_inactive` semantics and the two types that lack status; the snapshot-not-live caveat via `indexGeneratedAt`.
- **Semantics stay in the tool descriptions.** Clients that never load a Claude skill must still call the tools correctly — only strategy moves.
- Plugin layout per Claude Code's documented structure: components at the **plugin root**, never inside `.claude-plugin/`.
- **Distribution decision, made here not deferred:** `package.json` has `files: ["dist"]`, so `skills/`, `.claude-plugin/` and `.mcp.json` do not reach the npm tarball. This plan chooses **git/marketplace-only plugin distribution**; npm ships the bare server. README states both paths, including how an installed plugin locates the server and the index.

**Tests to write (automated):** the skill file parses and carries required frontmatter; `tools/list` total bytes is under 30,000.

**Manual gates (explicitly not `node:test`):** `claude plugin validate` passes; `claude --plugin-dir .` loads the plugin and `/mcp` lists five tools; a fresh `claude -p` session answers a Tibia question — evidence is the observable tool calls, not the answer text, since a correct answer does not prove the skill loaded.

---

## Completion Criteria

- [ ] `pnpm test` green, **0 skipped**, including all 71 pre-existing tests.
- [ ] Exactly five tools in `tools/list`, total **under 30,000 bytes** (recorded in the commit message).
- [ ] All **14** entity types resolvable through both `tibia_search` and `tibia_get`.
- [ ] `grep -rn 'searchTable' src/` empty — replaced, not duplicated.
- [ ] `world` and `update` resolve under both `include_inactive` values.
- [ ] Dragon returns `Great Fireball` `60-140` fire and `maxDamage.total` 430.
- [ ] `Rashid` returns a 7-entry weekly schedule.
- [ ] No new network: `grep -rnE "\bfetch\(|node:http|node:https|undici|axios" src/ '--include=*.ts' | grep -v '^src/indexer/'` still returns empty.
- [ ] Fixture under 1.5 MB with ≥1 row in every table the tools read.
- [ ] `claude plugin validate` passes.
