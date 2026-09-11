# Spike: can wiki ability scenes be joined to `creature_ability` rows?

**Date:** 2026-09-11 · **Status:** answered, then corrected under verification
**Question:** Plan C wants area-of-effect grids for creature abilities. The grids live
in `Module:SceneBuilder/data` and are referenced from creature wikitext, but
`tibiawiki-sql` discards the reference. Can the two be rejoined reliably enough to
ship, and at what coverage?

## Answer: yes — 92.7%, with the unjoinable remainder discarded rather than guessed

**400 randomly sampled creatures, 370 scene-carrying members**, measured against the
real index:

| Outcome | Count | Share |
|---|---:|---:|
| Joined uniquely | 343 | **92.7%** |
| Ambiguous (>1 candidate) | 3 | 0.8% |
| No matching row | 6 | 1.6% |
| Discarded — member kind the generator drops | 18 | 4.9% |

Counters sum to exactly 370.

## Corrections made under verification — read these before trusting the number

A first pass claimed **95.6%** and "every failure is detectable". Both were wrong,
and `codex-consult` caught all four errors. They are recorded because each one is a
trap the implementation would otherwise re-enter.

1. **The sample was biased.** It took the first 300 pages of the category, which is
   alphabetical, not random. The corrected figure is 92.7%, not 95.6%.
2. **The counters double-counted.** Ambiguous nameless members incremented two
   buckets, so the outcomes summed to 297 against 295 scenes. They now sum exactly.
3. **"The generator rewrites `fire` → `fire field`" was false.** The generator
   preserves `element=` verbatim; the wikitext *itself* says `element=fire field` and
   `element=life drain`. The real defect was a regex — `([a-z]+)` truncated the value
   at the space — and the "alias table" built on that false explanation happened to
   paper over one case while missing the other. **Capture the whole element value.**
4. **The nameless-member mapping produced silent wrong joins.** The generator's
   dispatch recognises only `Ability`, `Melee`, `Healing` and `Summon`. Mapping
   `{{Haste}}` by `element='haste'` looked right because the database *does* hold 10
   such rows — but those come from `{{Ability|…|element=haste}}`, verified on live
   pages. A `{{Haste}}` member's scene would have been attached to an unrelated
   ability. **Scenes on `Haste`, `Debuff` and `Outfit` must be discarded.**

## The join

Key on `(creature_id, name, effect, element)` — unique across all 5,854 rows
(`(creature_id, name)` collapses to 5,835; 14 name groups hold 33 rows).

Required normalisations, each established by measurement:

1. **Split template arguments at depth 0** — a wiki link carries its own pipe, so
   `{{Ability|Throws [[Distance Fighting|Knives]]|0-40}}` is two arguments.
2. **Collapse wiki links to display text**, as the generator does: that name is
   stored as `Throws Knives`.
3. **Capture the full `element=` value, spaces included** (`life drain`, `fire field`).
4. **Honour named arguments** (`name=`, `damage=`) as well as positional ones.
5. **Match in tiers, accepting only a tier that yields exactly one row**:
   `(name, effect, element)` → `(name, effect)` → `(name)`.
6. **Discard scenes on member kinds the generator drops** rather than mapping them.

## The failure guarantee, stated honestly

Failures are detectable *for the input shapes that occur*: they leave a candidate set
whose size is not 1, so they can be counted and skipped. The guarantee is **not
absolute**. `codex-consult` constructed a case that yields exactly one *wrong*
candidate — a member whose template name carries trailing whitespace (`{{Ability |`),
which the generator rejects on an exact name comparison but a tolerant parser accepts,
falling back to a surviving unrelated row.

I scanned **600 live creature pages and found zero occurrences**, so this is
theoretical rather than observed. The implementation should close it properly anyway,
by matching template names exactly as the generator does instead of relying on the
shape not appearing. Entity decoding (`&amp;`, `&#45;`) is a second gap in the same
family and is not yet handled.

## What this does not settle

The sample is 400 of 2,193 creatures (18%). Re-measure over the full corpus during
implementation, surface the skipped count, and threshold it so a future generator
change that breaks the join is loud rather than silent.

The spike code was throwaway and is not kept; this document holds everything needed
to rebuild it.
