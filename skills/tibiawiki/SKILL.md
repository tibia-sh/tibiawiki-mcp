---
name: tibiawiki
description: Use when answering questions about Tibia creatures, items, loot messages, NPCs, travel routes, quests, spells, imbuements, houses, achievements, mounts, outfits, worlds or game updates with the tibiawiki MCP server. Covers how to resolve names, how to read damage modifiers, and the data quirks that produce wrong answers if ignored.
---

# Querying TibiaWiki

Twelve tools over an **offline snapshot** of TibiaWiki. Every response carries
`indexGeneratedAt`. The data reflects the wiki at that moment, not live game or
server state. Say so when it matters (a recently changed creature, a new update).

## Pick the right tool

| You want | Use |
|---|---|
| The exact page name, given something approximate, or every page of a type | `tibia_search` |
| Everything about one named page | `tibia_get` |
| Creatures matching stats | `tibia_find_creatures` |
| Items matching stats, weapon element, leech or stackability | `tibia_find_items` |
| Spells by vocation, level, group or element | `tibia_find_spells` |
| Quests by level, premium, Rookgaard or location | `tibia_find_quests` |
| Houses by city, rent, beds or size | `tibia_find_houses` |
| Where an item comes from | `tibia_how_to_obtain` |
| What changed in the game, and when | `tibia_find_updates` |
| Where to sell a list of loot | `tibia_where_to_sell` |
| What pasted loot messages hold and are worth | `tibia_parse_loot` |
| Boat and carpet routes to or from a place | `tibia_find_travel` |

**Resolve names before fetching.** `tibia_get` takes an exact page name, the wiki
title. If the user says "dragonlord", "that fire dragon" or a name the game prints,
call `tibia_search` first. It matches titles by substring, and for items also the
in-game name and recorded plural. Results are ordered shortest-name-first, so the
closest match leads. Guessing a name and getting an error costs a round trip. For
"list every mount", pass `types` and no `query`.

**Three tools take the names the game prints.** `tibia_where_to_sell`,
`tibia_how_to_obtain` and `tibia_parse_loot` accept in-game names like "vial of
lifefluid", recorded plurals and English plurals like "gold coins". An exact title
wins in the first two. In a loot line the count and the creature weigh in first, so
"3 gold nuggets" is the stackable Gold Nugget and "a treasure map" from a pirate is the
pirate map. A name several items still share comes back as candidates, never a guess:
`ambiguousItems` in `tibia_where_to_sell`, an error listing them in
`tibia_how_to_obtain`, and `unresolvedEntries` in `tibia_parse_loot`, which first
keeps what the named creature drops. Pick one and call again, or ask the user.

**Parse loot with `tibia_parse_loot`.** Pass loot messages as the game prints them,
one per line, timestamps and notes like "(active prey bonus)" included. `totals`
gives each item's count and value and the `gold` sum, coins at face value and other
items at their best NPC price. Pass `include_lines: true` for each line's items with
client IDs and unit prices. `unresolvedEntries` and `unparsed` list the first 100,
and the counts in `totals` cover them all.

**Travel rows are single legs.** `tibia_find_travel` takes `to`, `from` or both, exact
place names in any case. `from` matches the leg's start, its `origin`. Each row gives the
NPC, the `origin`, the NPC's recorded city and position, the fare and `notes`. It does not
plan journeys, so chain legs yourself. A null `origin` is not recorded, and the leg starts
at one of the NPC's positions, which `tibia_get` lists as `positions`. A fare of 0 means
free or not recorded, and `sort: "price"` puts it last.

**Prefer `tibia_how_to_obtain` over two lookups.** It returns creature drops with
chances, NPC vendors with prices, and quest rewards in one call. Reaching for
`tibia_find_creatures` plus `tibia_get` to answer "where do I get X" is the slow path.
For "who buys X", call `tibia_get` on the item and read `boughtBy`, highest price first,
with each buyer's `city` and `position`. For a whole list of loot, call
`tibia_where_to_sell` once. It gives each item's best active buyer, grouped by city.
Rashid moves daily, so both give him city `null`, and `tibia_where_to_sell` adds his week.

**Client IDs map to items.** Pass `client_ids` to `tibia_find_items` to turn the IDs a
client uses into item names. Variants can share one, so an ID may return several items.

**Find updates by what changed, not by name.** For "what changed for knights in 2026"
or "which update added X", call `tibia_find_updates` with text and dates, then
`tibia_get` with `type: "update"` and the returned `title` for the full changes.

## Damage modifiers: 100 is neutral

Modifiers are percentages, **not** multipliers or resistances.

- `> 100`: takes **extra** damage. `weak_to: ["fire"]` finds these.
- `< 100`: resists. `resistant_to: ["fire"]`.
- `= 100`: neutral. `= 0`: **immune**.

A Dragon has `modifier_fire: 0`, so it is immune to fire, not weak to it. Never infer
weakness from a creature's own element. Dragons breathe fire *and* are immune to it.

## Data quirks that produce wrong answers

**`hitpoints: null` means unrecorded, not zero.** 433 creatures have no recorded
health upstream, including bosses with millions of experience. A range filter excludes
them rather than treating them as 0-HP. Never report "0 hitpoints".

**Drop `chance` is often null.** About 11% of drop rows have no recorded chance. Nulls
sort last. Absence of a chance is not a low chance.

**`imbuement.slots` is a category list, not a count.** `["swords","clubs","axes"]`
means which equipment it applies to.

**Two prices, two directions.** `soldByNpcs` in `tibia_how_to_obtain` is what the
player *pays* an NPC. `boughtBy` on a `tibia_get` item is what NPCs *pay* the player.
An NPC's `sells` is what you can buy from it, its `buys` what you can sell to it.

**`goldPerKill` is an estimate.** It is gross loot value at NPC prices. Drops without a
recorded chance are left out and items that sell only on the market count 0. `null`
means no drop has a recorded chance. Creature behaviour has meaningful zeros too:
`runsAt` 0 means it never flees, and a `summonCost` or `convinceCost` of 0 means it
cannot be summoned or convinced.

**An item with no sources is not an error.** `tibia_how_to_obtain` returns empty lists
plus a `note` for genuinely unobtainable items (Magic Longsword). Read the note.

**Non-active pages are hidden by default.** Deprecated, event-only and test-server
pages are excluded unless you pass `include_inactive: true`. If a user insists
something exists and you find nothing, retry with that flag. Then say the page is
not live content. `world` and `update` have no status at all, so the flag is a no-op
for them.

## Fourteen entity types

`creature`, `item`, `npc`, `quest`, `spell`, `achievement`, `house`, `imbuement`,
`charm`, `mount`, `outfit`, `book`, `world`, `update`.

Pass `type` to `tibia_get` when a name is ambiguous. `Mud` is both an item and an
NPC, and without a type the call returns an error asking you to choose.

## Detail worth knowing about

`tibia_get` returns more than the headline stats:

- **creature**: `abilities` with damage ranges and an `area` grid (below),
  `maxDamage` per element and total, `loot` with chances, the `name`, `plural`
  and `article` the game prints, and `raceId`, the client race ID, which boss phases
  can share, so it does not identify one creature
- **item**: EAV `attributes` (attack, defense, required level), `keys`, `storeOffers`,
  `proficiencyPerks`, `boughtBy`, the `actualName` and `plural` the game prints, and
  `isStackable`, `isPickupable` and `isImmobile`
- **npc**: `jobs`, `races`, `destinations` (travel with fares and each leg's `origin`),
  `positions` (every recorded spot), `buys`, `sells`. Rashid also carries
  `rashidSchedule`, his seven-day rotation
- **quest**: `dangers` as creature names, `rewards`
- **imbuement**: `materials` with amounts

Use `verbosity: "detailed"` for extra descriptive columns and for a book's full text,
which is omitted by default because it is the heaviest field in the corpus.

## Ability areas

An ability may carry an `area`: the tiles it covers, as a grid you can reason over.
The wiki draws these as animated GIFs, which are useless to a model, since only the
first frame of an animation is ever seen. So the underlying tile data is served instead.

```
. . . . . . # # #     '.' unaffected   '@' the caster
. . . # # # # # #     '#' effect tile  '*' the target tile
@ # # # # # # # #     4-8  extra sprite layers
. . . * # # # # #
. . . . . . # # #     Dragon's Fire Wave: 8sqmwave, 25 tiles, caster unharmed
```

`ascii` is the rendered grid, `cells` the same data row-major as numbers, `width`
and `height` its dimensions, `effectTiles` how many tiles the effect covers, and
`effectOnCaster` whether the caster is caught in it. That last one is stated by the
wiki, not inferred from the grid, because a caster tile can never also read as an
effect tile.

`area` is `null` for most abilities, and that is honest rather than missing: only
abilities the wiki drew a scene for have one. About 1,750 abilities across ~560
creatures do. The grid is oriented as the caster faces. It does not encode range,
cooldown, or whether the creature actually uses it at a given health threshold.

## Attribution

Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by
CipSoft; game content and images are copyright CipSoft GmbH. Carry this when quoting
substantial content.
