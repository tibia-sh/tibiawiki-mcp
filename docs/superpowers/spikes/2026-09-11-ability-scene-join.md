# Spike: can wiki ability scenes be joined to `creature_ability` rows?

**Date:** 2026-09-11 · **Status:** answered — Plan C is unblocked
**Question:** Plan C wants to serve area-of-effect grids for creature abilities. The
grids live in `Module:SceneBuilder/data` and are referenced from creature wikitext,
but `tibiawiki-sql` discards the reference. Can the two be rejoined reliably enough
to ship, and at what coverage?

## Answer: yes — 95.6%, with the remainder loudly skipped rather than silently wrong

Sampled **284 creatures / 295 scene-carrying members** against the real 14 MB index.

| Outcome | Count | Share |
|---|---:|---:|
| Joined uniquely | 282 | **95.6%** |
| Ambiguous (>1 candidate) | 2 | 0.7% |
| No matching row | 2 | 0.7% |
| Nameless member, unmatched | 11 | 3.7% |

The two failure modes are **detectable at build time**: both produce a candidate set
whose size is not 1, so they can be counted in `skipped` and never stored. Nothing is
ever attached to the wrong ability.

## Why this replaces the ordinal approach

The plan gate rejected `ability_ordinal` after measuring it at **81% aligned, with
~19% silently misassigned** — the generator drops members mid-list, shifting every
subsequent ordinal, and a shifted ordinal is still in range so no guard catches it.
This approach is both more accurate *and* fails loudly. That second property is what
makes it shippable.

## The join

Key on `(creature_id, name, effect, element)` — **unique across all 5,854 rows**
(`(creature_id, name)` collapses to 5,835).

Four normalisations are required, each discovered by measurement:

1. **Split template arguments at depth 0.** A wiki link carries its own pipe:
   `{{Ability|Throws [[Distance Fighting|Knives]]|0-40}}` is two arguments, not three.
2. **Collapse wiki links to display text**, because the generator does:
   `Throws [[Distance Fighting|Knives]]` is stored as `Throws Knives`.
3. **Alias element shorthand.** The wikitext says `element=life`; the database says
   `life drain` — with a space, not `lifedrain`.
4. **Match in tiers**, accepting only a tier that yields exactly one row:
   `(name, effect, element)` → `(name, effect)` → `(name)`. The looser tiers are
   needed because the generator sometimes rewrites the element: an ability declared
   `element=fire` that creates fields is stored as `fire field`.

Skipping any one of these costs real coverage — before them the rate was 79.3%.

## Nameless members

`{{Healing}}`, `{{Haste}}`, `{{Debuff}}`, `{{Summon}}` and `{{Melee}}` carry no name
argument, but the generator gives each a canonical row: `Healing` → name
`Self-Healing` / element `healing`; `Haste` → element `haste` (10 rows corpus-wide);
`Debuff` → element `debuff` (2 rows); `Summon` → element `summon`; `Melee` → name
`Melee`. Only **`{{Outfit}}` has no row at all** and is structurally unattachable.

This corrects an earlier review claim that `Haste` and `Debuff` members are dropped
entirely — they are not.

## What this does not settle

The sample is 284 creatures of 2,193 (13%). The rate should be re-measured over the
full corpus during implementation, and the `skipped` count surfaced and thresholded
so a future generator change that breaks the join is loud rather than silent.

The spike code itself was throwaway and is not kept; everything needed to rebuild it
is in this document.
