# Test fixture

`tibiawiki-fixture.db` is a trimmed SQLite database used by the test suite. It is
committed so tests are deterministic and never touch the network.

## Contents

It is not a random sample. Each retained row exists to make a specific test meaningful:

- **Dragon** (`modifier_fire` 0) — the fire-immune case that must be *excluded* from a
  fire-weakness search. Guards against inverting the comparison.
- **Tarantula** (115) and **Scarab** (118) — genuinely fire-weak, so the headline query
  returns a non-empty set. Without them the test would pass vacuously on an empty array.
- **Steel Helmet** and its 22 droppers — the vendor case (580 gold on the sell side,
  293 on the buy side, which is the direction bug the tests guard), and the source of
  the null-chance drop rows that make nulls-last ordering testable.
- **Magic Longsword** — genuinely unobtainable, so "no source" returns empty lists and
  a note rather than an error.
- **Mud** — the only cross-type title collision in the entire corpus, and therefore the
  only way to exercise the ambiguous-name branch.
- **Gold Coin** — the currency join target for vendor prices.
- One non-`active` creature, so the status filter has something to exclude.

Every new entity type keeps one or two **named** rows chosen because they actually
carry the child data the detail tests assert on — a type with no children proves
nothing:

- **Captain Bluebear** — 12 `npc_destination` rows. The fixture previously held
  **zero**, so "an NPC with destinations" could not have passed.
- **Harlow** and **Sebastian** — two `npc_location` rows each, and legs that carry an
  `origin`. Harlow's Yalahar leg leaves from Farmine while his Vengoth leg names none,
  and Sebastian's Liberty Bay fare is 50 from Meriana and 100 from Nargor.
- **Golden Key** — 7 `item_key` rows. `item_key` is one-to-many (Silver Key has 61),
  so a singular field read with `.get()` would silently drop rows.
- **The Plasmother** — three abilities all named `Poison Ball`. `(creature_id, name)`
  is not unique, so this proves detail joins keep all three.
- **Powerful Reap**, **Assassin Outfits**, **Goldfinger (Book)**, **Warriors' Guildhall**,
  **Updates/7.9**, **Rashid** — one anchor each for materials, outfit quests, a book with
  an item, house rent, a game update, and the 7-row weekly schedule.

Retention pulls in each named row's foreign-key targets. This matters: the orphan
sweep *deletes* an offending row rather than repairing it, so a named row whose
target were missing would simply vanish. A misspelled name now throws rather than
yielding an empty table.

Tables no tool queries are emptied but kept, so the schema stays identical to a real
index. That is what keeps the file near 1.3 MB, inside the 1.5 MB budget
`test/fixture-shape.test.ts` enforces.

## Area tables

`mcp_area_pattern`, `mcp_ability_area` and `mcp_schema_version` are written by the
build-time enrichment pass, not by the generator, so they only exist if the source
index was already enriched. Regenerate in that order or the tables come out missing.

They are retained differently from everything else:

- `mcp_area_pattern` is kept whole (114 rows, a few KB). It is the lookup target for
  every retained ability, so trimming it would only create dangling keys.
- `mcp_schema_version` is kept whole. It is one row, and the probe rejects an index
  without it - an emptied one makes the whole fixture unopenable.
- `mcp_ability_area` is pruned by `creature_id`. It cannot ride on the `article_id`
  pruning other child tables use, nor on the foreign-key sweep, whose key points at
  the pattern table rather than at `creature`.

Anchors: Dragon carries `Fire Wave` -> `8sqmwave` and a `Self-Healing` with
`effect_on_caster = 1`; The Rootkraken carries `Death and Holy AoE` -> `rootkraken1`,
whose key is single-quoted upstream and whose grid uses cell value 4.

## Reproducing it

The committed fixture was cut from the index `@tibia.sh/tibiawiki-data` 3.1.0 ships,
whose `database_info` `version` is `9.0.0+tibiash.1`. With that version installed:

```bash
node scripts/make-fixture.mjs node_modules/@tibia.sh/tibiawiki-data/index.db \
  test/fixtures/tibiawiki-fixture.db
```

To cut it from an index you build yourself instead, from the repository root:

```bash
pnpm build
TIBIAWIKI_MCP_DB=data/tibiawiki.db node dist/index.js build-index
                                          # ~3 min generate + ~25 s enrichment;
                                          # data/tibiawiki.db is gitignored
node scripts/make-fixture.mjs data/tibiawiki.db test/fixtures/tibiawiki-fixture.db
```

Without `TIBIAWIKI_MCP_DB`, `build-index` writes to the cache path,
`~/.cache/tibiawiki-mcp/tibiawiki.db` (or under `$XDG_CACHE_HOME`), not to `data/`.

`build-index` generates, enriches, validates, then installs atomically. Enrichment
fetches the live wiki and fails the build if stored areas fall below 95% of eligible
scenes; it measured 98.8% (1,748 of 1,770) on 2026-09-11.

The full index is not in the repository. It comes from the data package or from `build-index`.

## Attribution

This fixture is redistributed wiki content: data from TibiaWiki
(https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by CipSoft; game content
and images are copyright CipSoft GmbH. No images are included.

## `spell-areas-measured.json`

The decoder's regression oracle, not documentation. It holds the 30 masks the original
prototype produced, and `test/spell-areas-data.test.ts` compares every served shape in
`data/spell-areas.json` against it cell for cell.

It matters because there is **no external source of truth** for player spell areas:
this artefact is the only thing that would catch a decoder change silently altering a
shape. It lived under `docs/` briefly, was gitignored along with the rest of that
directory, and the guard failed on any fresh clone while passing locally. Keep it here,
tracked.
