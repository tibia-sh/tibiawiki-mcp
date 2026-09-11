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

---

## Addendum — full-corpus re-measurement (2026-09-11, post-gate)

The plan gate rejected Plan C partly on this spike's residual risk: 92.7% came from
400 of 2,193 creatures (18%). Re-run over **every** creature page instead.

### Result — 1,856 scenes across 2,209 creature pages

| Outcome | Count | Share |
|---|---:|---:|
| **joined uniquely** | **1,749** | **94.2%** |
| ambiguous | 0 | 0.0% |
| no matching row | 21 | 1.1% |
| discarded — dropped kind (`Haste`/`Debuff`/`Outfit`) | 79 | 4.3% |
| discarded — no `spell=` (inline `input_array`) | 6 | 0.3% |
| discarded — `rotate90=yes` | 1 | 0.1% |
| **sum** | **1,856** | 100% |

Higher than the sample suggested, and **0 ambiguous**: the tiered four-column match
never mis-assigned once across the whole corpus. Of the 21 misses, 11 are
`{{Healing}}` members on pages whose generated row carries a different name; the
other 10 are singletons.

### Two facts this spike got wrong, corrected here

1. **`Module:SceneBuilder/data` defines 114 patterns, not 94** — 94 written `["key"]`
   plus 20 written `['key']`. A double-quote-only regex returns exactly 94, which is
   why the wrong number looked self-consistent. All 114 satisfy `cells % width == 0`.
2. **The cell legend was wrong.** `Module:SceneBuilder` defines
   `[0] tile_only · [1] effect · [2] caster · [3] target · [4]–[8] extra_sprite_1..5`.
   `3` is the **target tile**, not a direction marker — direction is the Scene's own
   `look_direction=`. Values **0–5 are in live use**; 9 of the 114 patterns use ≥4.

### Newly measured, not previously known

- **Per-kind argument mapping** — the six normalisations were incomplete. Each member
  kind produces its triple differently: `Melee` → name `Melee`, element defaults
  `physical`, effect defaults `?`; `Healing` → element always `healing`, effect from
  `range=`, name defaults `Self-Healing` but varies (`Frequent Self-Healing` ×18,
  `Self Healing` ×11, `Mass Healing` ×6); `Summon` → name is the summoned creature,
  effect the amount, element `summon`. Ignoring this scored **0%**, not a degraded rate.
- **Depth counting must include `{{ }}`.** The reference is a *nested* template,
  `scene={{Scene|spell=<key>|…}}`. Counting only `[[ ]]` shreds every scene-carrying member.
- **`effect_on_caster=yes` appears on 463 scenes (24.8%)** — this, not the grid, is
  what says whether the caster is inside the effect.
- **`sprite_1`…`sprite_5` name what cells `4`–`8` mean** (`sprite_1` ×13, `sprite_2` ×2),
  e.g. The Rootkraken's `sprite_1=Holy Effect`. Cell `4` is not "unknown" — it is a
  named effect the Scene itself supplies.
- **`creature_ability` mixes NULL and `''`** for the same meaning: `effect` is NULL on
  126 rows and `''` on 137. Matching and storage must both be NULL-safe.
- Anchors: `8sqmwave` = 45 cells / width 9 / 5 rows (confirmed);
  `rootkraken1` = 117 cells / width 9 / 13 rows / values 0–4.
- 101 of the 114 defined keys are actually referenced by creature pages.

**Method:** live `action=query` over all 2,209 `Category:Creatures` pages, joined
against the local index (5,854 ability rows; the four-column key is unique across
all of them, `(creature_id, name)` collapses to 5,835 — both confirmed).

## Addendum 2 — tier distribution and identity drift (2026-09-11)

Raised by the second gate pass: after a fallback tier matches, the *extracted*
`(effect, element)` need not equal the *matched row's*. Storing the extracted form
makes the row unretrievable by an exact runtime join. Measured over the full corpus:

| Tier | Joins | Identity drift |
|---|---:|---:|
| 1 — `(name, effect, element)` | 1,055 | 0 |
| 2 — `(name, effect)` | 553 | **553** |
| 3 — `(name)` | 141 | **141** |
| **total** | **1,749** | **694 (39.7%)** |

**Every tier-2 and tier-3 join drifts** — by construction: a fallback tier matches
precisely when the dropped component differs. Typical shape: wikitext omits
`element=`, the generator's row defaults it (`('1300-1500','')` → `('1300-1500','physical')`).

**Consequence had this shipped:** enrichment would store 1,749 rows and report a
passing 98.8% stored/eligible, while 39.7% of them returned `null` at runtime. The
build gate would not have caught it — it counts rows written, not rows retrievable.

**Why the tests would not have caught it either:** the planned runtime anchors —
Dragon's `Fire Wave` and `Self-Healing` — are both tier-1, the only tier that does not
drift. The repo's recurring failure mode reproduced once more, in the acceptance
criteria rather than the code.

**Required:** `SceneRef` carries the **matched row's** normalised
`(name, effect, element)`, never the extracted text; and at least one runtime test
must anchor on a **tier-2 or tier-3** ability, since a tier-1 anchor cannot fail.

**Correction to Addendum 1:** it said the tiered match "never mis-assigned once
across the whole corpus." That overstates the evidence. 0 ambiguous means no
*detected* ambiguity — a tier that matches exactly one row can still match the wrong
one. The measurement bounds detectable collisions, not correctness.

## Addendum 3 — scene-count reconciliation (2026-09-11)

The second gate flagged a residual risk: a reviewer's 200-page sample projected
~2,030 corpus scenes against Addendum 1's 1,856. Resolved by counting raw
`scene={{Scene` occurrences across all 2,209 category pages.

| Quantity | Count |
|---|---:|
| raw `scene={{Scene` occurrences | **1,874** |
| seen by the member parser | 1,856 |
| **invisible to the parser** | **18** |
| on pages absent from the index | 0 |

1,856 + 18 = 1,874 exactly. The ~2,030 projection was sampling variance; the
measured total stands.

### The 18, identified exactly

`{{Ability |` ×8 · `{{Haste\n  |` ×7 · `{{Haste\n   |` ×1 · `{{Ability\n        |` ×1 · `{{healing|` ×1

MediaWiki strips whitespace around template names, so these *are* the same
templates — which made the plan's "match the template name exactly" rule look
wrong. **It is not.** Every one of the 10 `Ability`/`healing` variants was checked
against the index: `row_exists=False` for all 10 (`Iks Yapunac`, `Soulsnatcher`,
`The Scourge of Oblivion` and its variants). The generator does not emit rows for
whitespace- or case-variant openers, so discarding their scenes is correct — and
this is now verified rather than assumed. The other 8 are `Haste`, a dropped kind.

### The real gap

These 18 are not merely discarded, they are **never seen**, so they fall out of the
`scenes` denominator silently and no counter can observe them. A parser regression
that started missing legitimate members would shrink the denominator and could
*raise* the reported rate. Extraction must count unparsed member openers explicitly.

### Also established

**No `Melee` or `Summon` member carries a scene anywhere in the corpus** — scene-bearing
members are `Ability` 1,681, `Healing` 96, `Debuff` 41, `Outfit` 20, `Haste` 18. The
per-kind mapping for `Melee` and `Summon` is therefore defensive only; tests for those
paths are author-invented fixtures exercising code that never fires in production, and
should be labelled as such rather than presented as corpus-backed.
