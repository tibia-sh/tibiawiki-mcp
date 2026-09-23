---
name: tibiawiki
description: Use when answering questions about Tibia — creatures, items, loot, NPCs, quests, spells, imbuements, houses, achievements, mounts, outfits, worlds or game updates — using the tibiawiki MCP server. Covers how to resolve names, how to read damage modifiers, and the data quirks that produce wrong answers if ignored.
---

# Querying TibiaWiki

Six tools over an **offline snapshot** of TibiaWiki. Every response carries
`indexGeneratedAt` — the data reflects the wiki at that moment, not live game or
server state. Say so when it matters (a recently changed creature, a new update).

## Pick the right tool

| You want | Use |
|---|---|
| The exact page name, given something approximate | `tibia_search` |
| Everything about one named page | `tibia_get` |
| Creatures matching stats | `tibia_find_creatures` |
| Items matching stats | `tibia_find_items` |
| Where an item comes from | `tibia_how_to_obtain` |
| What changed in the game, and when | `tibia_find_updates` |

**Resolve names before fetching.** `tibia_get` takes an exact page name. If the user
says "dragonlord" or "that fire dragon", call `tibia_search` first — results are
ordered shortest-name-first, so the closest match leads. Guessing a name and getting
an error costs a round trip.

**Prefer `tibia_how_to_obtain` over two lookups.** It returns creature drops with
chances, NPC vendors with prices, and quest rewards in one call. Reaching for
`tibia_find_creatures` plus `tibia_get` to answer "where do I get X" is the slow path.

**Find updates by what changed, not by name.** For "what changed for knights in 2026"
or "which update added X", call `tibia_find_updates` with text and dates, then
`tibia_get` with `type: "update"` and the returned `title` for the full changes.

## Damage modifiers: 100 is neutral

Modifiers are percentages, **not** multipliers or resistances.

- `> 100` — takes **extra** damage. `weak_to: ["fire"]` finds these.
- `< 100` — resists. `resistant_to: ["fire"]`.
- `= 100` — neutral. `= 0` — **immune**.

A Dragon has `modifier_fire: 0`, so it is immune to fire, not weak to it. Never infer
weakness from a creature's own element — dragons breathe fire *and* are immune to it.

## Data quirks that produce wrong answers

**`hitpoints: null` means unrecorded, not zero.** 433 creatures have no recorded
health upstream, including bosses with millions of experience. A range filter excludes
them rather than treating them as 0-HP. Never report "0 hitpoints".

**Drop `chance` is often null.** About 11% of drop rows have no recorded chance. Nulls
sort last. Absence of a chance is not a low chance.

**`imbuement.slots` is a category list, not a count** — `["swords","clubs","axes"]`
means which equipment it applies to.

**Vendor prices are the buying price.** `soldByNpcs` is what the player *pays*. The
lower sell-back price is not reported.

**An item with no sources is not an error.** `tibia_how_to_obtain` returns empty lists
plus a `note` for genuinely unobtainable items (Magic Longsword). Read the note.

**Non-active pages are hidden by default.** Deprecated, event-only and test-server
pages are excluded unless you pass `include_inactive: true`. If a user insists
something exists and you find nothing, retry with that flag — then say the page is
not live content. `world` and `update` have no status at all, so the flag is a no-op
for them.

## Fourteen entity types

`creature`, `item`, `npc`, `quest`, `spell`, `achievement`, `house`, `imbuement`,
`charm`, `mount`, `outfit`, `book`, `world`, `update`.

Pass `type` to `tibia_get` when a name is ambiguous — `Mud` is both an item and an
NPC, and without a type the call returns an error asking you to choose.

## Detail worth knowing about

`tibia_get` returns more than the headline stats:

- **creature** — `abilities` with damage ranges and an `area` grid (below),
  `maxDamage` per element and total, `loot` with chances
- **item** — EAV `attributes` (attack, defense, required level), `keys`, `storeOffers`,
  `proficiencyPerks`
- **npc** — `jobs`, `races`, `destinations` (travel with fares); Rashid additionally
  carries `rashidSchedule`, his seven-day rotation
- **quest** — `dangers` as creature names, `rewards`
- **imbuement** — `materials` with amounts

Use `verbosity: "detailed"` for extra descriptive columns and for a book's full text,
which is omitted by default because it is the heaviest field in the corpus.

## Ability areas

An ability may carry an `area`: the tiles it covers, as a grid you can reason over.
The wiki draws these as animated GIFs, which are useless to a model — only the first
frame of an animation is ever seen — so the underlying tile data is served instead.

```
. . . . . . # # #     '.' unaffected   '@' the caster
. . . # # # # # #     '#' effect tile  '*' the target tile
@ # # # # # # # #     4-8  extra sprite layers
. . . * # # # # #
. . . . . . # # #     Dragon's Fire Wave: 8sqmwave, 25 tiles, caster unharmed
```

`ascii` is the rendered grid, `cells` the same data row-major as numbers, `width`
and `height` its dimensions, `effectTiles` how many tiles the effect covers, and
`effectOnCaster` whether the caster is caught in it — that last one is stated by the
wiki, not inferred from the grid, because a caster tile can never also read as an
effect tile.

`area` is `null` for most abilities, and that is honest rather than missing: only
abilities the wiki drew a scene for have one. About 1,750 abilities across ~560
creatures do. The grid is oriented as the caster faces; it does not encode range,
cooldown, or whether the creature actually uses it at a given health threshold.

## Attribution

Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by
CipSoft; game content and images are copyright CipSoft GmbH. Carry this when quoting
substantial content.
