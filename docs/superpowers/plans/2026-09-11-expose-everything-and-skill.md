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
- **`tools/list` byte budget: 30,000.** Measured today: **14,149** total (descriptions 1,296 · inputSchemas 4,158 · outputSchemas 8,016, of which `tibia_get.outputSchema` is 4,992 for five union members ≈ 998 b/member). Fourteen members project to ~13 KB, and Task 3's detail arrays grow the five existing members too — the parent plan's "+8 KB" estimate ignored that and was optimistic. Projected landing point is ~27,000–27,500, so the gate has roughly **9% headroom** — enough, but not generous. **If it breaches, the stated lever is to move `world`'s board/date columns and `update.changes` into `detail` rather than raise the budget.** (Note the 25,000-token Claude Code cap governs tool *results*, not `tools/list`, and 30,000 bytes is ~7.5k tokens — related, but not the same limit.)
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
- Retain child rows for creatures and items already in the fixture: `creature_ability`, `creature_max_damage`, `creature_sound`, `item_sound`, `item_store_offer`, `item_proficiency_perk`, `npc_job`, `npc_race`, `quest_danger`.
- **Two of those tables are empty for the entities the fixture already holds and must be named explicitly, or Task 3's tests cannot pass.** Measured against the committed fixture: `npc_destination` **0 rows** and `item_key` **0 rows** — no captain and no key item is currently retained. Name at least `Captain Bluebear` (12 destinations) and `Golden Key`/`Bone Key`.
- **Retention must also pull in every FK target of a retained row.** The existing `pragma foreign_key_check` sweep deletes *the offending row itself*, so a named row whose target is absent is removed rather than repaired: a book needs its `book.item_id` item, an imbuement needs its `imbuement_material.item_id` items, an outfit needs its `outfit_quest.quest_id` quest — and the script currently derives quests only from `quest_reward`.
- **Retain `Dragon`'s abilities specifically**, since Task 3's known-answer test asserts `Great Fireball` `60-140`.
- Retain a creature with a **duplicate ability name** (creature 14359 has three `Poison Ball` rows) so the composite-key behaviour has an anchor.
- The existing `pragma foreign_key_check` orphan sweep still runs and must still report clean.
- Update `test/fixtures/README.md`: its claims "Tables no tool queries are emptied" and the 1 MB rationale both change.

**Tests to write:** a fixture-shape test asserting ≥1 row in every table Tasks 2–3 query, naming each table, so a future trim cannot silently empty one; the duplicate-ability creature is present; `Dragon` has 4 abilities.

**Acceptance:**
- `node scripts/make-fixture.mjs data/tibiawiki.db test/fixtures/tibiawiki-fixture.db` writes a file **under 1.5 MB** and reports referential integrity clean.
- `pnpm test` green — **all 72 existing tests still pass**, which is the real gate here.
- One assertion is expected to need updating: `test/find-items.test.ts` asserts `totalMatches === 2` for `attack_min: 50`, deliberately exact. If a newly retained item clears that bar, update the number as an **intentional change recorded in the commit message** — never by loosening the assertion, which is the whole reason it is exact.

---

### Task 2: Fourteen entity types, one identity map, conditional status

**Why:** 23 tables are unreachable. Types on the two lookup tools beat eight new tools: the measured selection cliff is 30–50 tools session-wide and is shared with every other server the user runs.

**Files:** Modify `src/domain.ts`, `src/tools/search.ts`, `src/tools/get.ts`, `src/db.ts`, `test/domain.test.ts` (it imports and asserts on `searchTable` four times); create `test/entities.test.ts`

**Contract:**
```ts
export const ENTITY_TYPES: readonly ['creature','item','npc','quest','spell',
  'achievement','house','imbuement','charm','mount','outfit','book','world','update'];
export function entityTable(type: EntityType): string;        // closed map, throws on unknown
export function entityChildFk(type: EntityType): string;       // closed map: 'creature_id' | 'item_id' | ...
export function entityHasStatus(type: EntityType): boolean;    // false for 'world' and 'update'
// `searchTable` is REPLACED by `entityTable` and deleted — no duplicate path survives.
```

**Behavior:**
- `tibia_search` and `tibia_get` both accept all 14 types. `tibia_get`'s union gains the nine members enumerated in Verified Facts, with those exact columns.
- **Status filtering becomes conditional in both tools.** Today each applies `statusClause` unconditionally; for `world` and `update` that raises `no such column: status`. Where `entityHasStatus(type)` is false, the clause is omitted and `include_inactive` is documented as a no-op for that type.
- Scalar nullability is taken from the upstream column definition, not inferred from whichever rows the fixture happens to hold.
- `src/db.ts`'s probe covers every table now read.
- **No `entityIdColumn`.** All 14 entity tables use `article_id` as their primary key (verified), so such a map would be a 14-entry constant — speculative code, which this repo's `CLAUDE.md` forbids. The genuinely per-type mapping is the **child FK column** (`creature_id`, `item_id`, `npc_id`, `quest_id`, `imbuement_id`, `outfit_id`), which is what `entityChildFk` provides.

**Tests to write:** `tools/list` still advertises exactly 5 tools; `tibia_search` returns non-empty results for each of the 9 new types; `tibia_get` returns the correct discriminated member for one named entity of each new type and validates against `outputSchema`; `world` and `update` resolve under **both** `include_inactive` values without raising `no such column`; one known-answer per new type (a named imbuement's tier, a named house's rent) guards silent column drift; `entityTable`/`entityChildFk`/`entityHasStatus` each reject an out-of-enum key **and each inherited prototype name** (`toString`, `constructor`, `valueOf`, `__proto__`) — a plain-object lookup resolves those to truthy `Object.prototype` members, which is a real bug already fixed in the shipped maps (`a6e46c9`).

**Acceptance:** `pnpm test` green; `grep -rn 'searchTable' src/` returns empty (the old map is gone, not shadowed); `tools/list` total bytes recorded and **under 30,000**.

---

### Task 3: Detail sections — combat, travel, materials, rewards

**Why:** The most glaring gap. Today an agent learns a Dragon is fire-immune but not that it casts Great Fireball for 60–140 or hits for 430 total. These are child tables of entities `tibia_get` already returns.

**Files:** Modify `src/tools/get.ts`, `src/db.ts`; create `test/detail.test.ts`

**Behavior:** per union member —
- **creature** — `abilities[]` from `creature_ability` (`name`, `effect`, `element`); `maxDamage` from `creature_max_damage` (per element plus `total`); `sounds[]`. **No `area` field** — that is Plan C and must not be stubbed in here.
- **item** — `keys[]` (**not** a singular `keyInfo`: `item_key.item_id` is a plain FK and Silver Key has **61** rows, Copper Key 44 — a `.get()` here silently drops 60), `storeOffers[]`, `proficiencyPerks[]`, `sounds[]`.
- **npc** — `jobs[]`, `races[]`, `destinations[]`; and for `Rashid` only, `rashidSchedule[]` from `rashid_position` (`day, city, location, x, y, z`).
- **quest** — `dangers[]`, `rewards[]`.
- **imbuement** — `materials[]`. **outfit** — `quests[]`.
- Rows are read with an explicit `ORDER BY` that is a **total** order — **never implicit `rowid` order**, since `make-fixture.mjs` runs `VACUUM` and SQLite may renumber rowids for tables without an INTEGER PRIMARY KEY (every child table here is a plain rowid table). For `creature_ability` the total order is `(name, effect, element)`: The Plasmother's three `Poison Ball` rows tie on `name` alone, and that is exactly the row set the duplicate test asserts.
- Only `book.text` is gated behind `verbosity: 'detailed'`. **`quest.legend` stays where it is** — it is a top-level field of the shipped `questOut` schema, and its mean length is 109 characters across 370 quests (33 KB total), so moving it would break a shipped contract for no measurable gain.

**Tests to write:** item detail is covered, not just creature detail — a multi-key item (`Golden Key`) returns **all** its `keys[]` rows, and `storeOffers`, `proficiencyPerks` and item `sounds` each return non-empty schema-valid data for a named item (without these, the one-to-many bug above ships silently); Dragon returns 4 abilities including `Great Fireball` / `60-140` / `fire`; Dragon's `maxDamage.fire` is 310 and `total` 430; the duplicate-ability creature returns **all three** `Poison Ball` rows, not one (guards any accidental de-duplication by name); an NPC with destinations returns them; `Rashid` returns a 7-entry schedule; concise omits `book.text` while detailed includes it; an entity whose child table is empty returns `[]` rather than null or an error.

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

---

## Review (2026-09-11)

- **Verdict: Ready.**
- Reviewers: `codex-consult` (high, 32,645 tokens) — *Ready with small improvements, no blocking issues*; `plan-final-reviewer` (opus, 28 tool calls) — *Needs revision, but "only two small, mechanical edits are required, not a redesign"*; `grok-consult` — not run.
- **Disagreement decided here**, as the gate permits: both reviewers' issues were mechanical contract edits with no redesign implied, and all of them are applied below. Neither reviewer found a design, sequencing or safety defect. Stamping `Ready` rather than bouncing a document whose only faults are now fixed.

### Independently re-derived and confirmed

`plan-final-reviewer` re-measured every Verified Fact against the real index and all hold: 27,263 rows over 23 non-empty tables; all nine new members' columns exist; `world` and `game_update` genuinely lack `status`; `rashid_position` lacks `title`/`article_id`; `(creature_id,name,effect,element)` is unique over all 5,854 rows; the fixture is empty for the listed tables; `tools/list` is 14,149 bytes. **All six carry-forward defects from the parent's round-2 stamp are genuinely fixed, not reworded.**

Also settled: widening `tibia_get` from 5 to 14 candidate tables adds **zero** new ambiguity errors — `Mud` remains the only cross-type title collision corpus-wide, and the fixture already covers it.

### Adopted (all applied before this stamp)

1. **`keyInfo` → `keys[]`.** `item_key.item_id` is a plain FK — Silver Key has **61** rows, Copper Key 44. A singular field invites `.get()` and silently drops 60.
2. **Task 1's retention premise was measurably false.** The fixture has **0** `npc_destination` and **0** `item_key` rows for the entities it already holds, so Task 3's tests could not have passed. Specific rows are now named, plus a rule that retention must pull in every FK target — the orphan sweep deletes the offending row, so a named row whose target is missing is removed rather than repaired.
3. **Item detail is now tested.** `storeOffers`, `proficiencyPerks`, `sounds` and multi-key items had no assertions at all — the same silent-loss class that got the parent plan rejected.
4. **`entityIdColumn` dropped as speculative** — all 14 entity tables key on `article_id`, so it would be a 14-entry constant. Replaced by `entityChildFk`, the genuinely per-type mapping.
5. **`ORDER BY` must be total** — `(name, effect, element)` for `creature_ability`, since The Plasmother's three `Poison Ball` rows tie on `name` alone.
6. **`quest.legend` stays top-level** — moving it would silently break a shipped schema for a 109-character mean field.
7. **Budget lever named** — ~9% headroom, so if 30,000 breaches, move `world` board/date and `update.changes` into `detail` rather than raise the gate. The 25,000-token cap governs tool *results*, not `tools/list`; that rationale sentence was loose.
8. **New maps must reject prototype names**, matching the shipped fix in `a6e46c9`.
9. `test/domain.test.ts` added to Task 2's Files; the exact-count assertion in `test/find-items.test.ts` flagged as an intentional-change point.

### Found in shipped code during this gate, fixed separately

- `a6e46c9` — four of five closed SQL-fragment maps returned inherited `Object.prototype` members instead of throwing. Not exploitable (Zod gates them) but the contract said otherwise, and the existing negative test passed because it used plausible wrong values rather than prototype names. Red-green verified.
- The `spell.title is the one identity column without COLLATE NOCASE` comment was wrong — `imbuement` and `book` also lack it. Corrected.

### Not worth changing

`**Review tier:** single` (no network, read-only DB, closed maps behind a Zod enum). Fixture-first sequencing. Fourteen types through five tools. The single code fence is signatures plus a deletion note, not a body. The deliberate exclusion of Plans B and C.

### Residual risk carried into execution

The `tools/list` projection (~27 KB against a 30 KB gate) is an estimate; it is checkable in one command at Task 2 and Task 3 acceptance, but slack is thin. Task 4's meaningful gates are manual by necessity, so plugin packaging carries no CI coverage.
