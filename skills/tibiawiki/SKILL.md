---
name: tibiawiki
description: Use when answering questions about Tibia — creatures, items, loot, NPCs, quests, spells, imbuements, houses, achievements, mounts, outfits, worlds or game updates — using the tibiawiki MCP server. Covers how to resolve names, how to read damage modifiers, and the data quirks that produce wrong answers if ignored.
---

# Querying TibiaWiki

Five tools over an **offline snapshot** of TibiaWiki. Every response carries
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

**Resolve names before fetching.** `tibia_get` takes an exact page name. If the user
says "dragonlord" or "that fire dragon", call `tibia_search` first — results are
ordered shortest-name-first, so the closest match leads. Guessing a name and getting
an error costs a round trip.

**Prefer `tibia_how_to_obtain` over two lookups.** It returns creature drops with
chances, NPC vendors with prices, and quest rewards in one call. Reaching for
`tibia_find_creatures` plus `tibia_get` to answer "where do I get X" is the slow path.

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

- **creature** — `abilities` with damage ranges, `maxDamage` per element and total,
  `loot` with chances
- **item** — EAV `attributes` (attack, defense, required level), `keys`, `storeOffers`,
  `proficiencyPerks`
- **npc** — `jobs`, `races`, `destinations` (travel with fares); Rashid additionally
  carries `rashidSchedule`, his seven-day rotation
- **quest** — `dangers` as creature names, `rewards`
- **imbuement** — `materials` with amounts

Use `verbosity: "detailed"` for extra descriptive columns and for a book's full text,
which is omitted by default because it is the heaviest field in the corpus.

## Attribution

Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by
CipSoft; game content and images are copyright CipSoft GmbH. Carry this when quoting
substantial content.
