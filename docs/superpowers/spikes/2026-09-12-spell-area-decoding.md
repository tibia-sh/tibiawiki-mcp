# Spike — deriving spell area grids from the wiki's own animations

**Date:** 2026-09-12 · **Question:** can a spell's affected-tile set be recovered from
its area GIF, well enough to serve as machine-readable data?

**Answer: yes for the shape, with three complications that need deciding before it
becomes a plan.** Prototyped end to end on three real images.

## What unblocked it

The earlier conclusion that these images were unfetchable was **wrong** — see the
retraction in `docs/superpowers/plans/2026-09-12-image-links.md`. The 403 was
hot-link protection: sending `Referer: https://tibia.fandom.com/` returns 200. That
Referer is truthful, and an honest bot User-Agent works where a spoofed Chrome one
is rejected.

## Pipeline, with no new dependencies

1. `imageinfo` gives the URL; fetch with a `Referer`.
2. Fandom's own thumbnailer (`x-thumbnailer: Thumblr`) re-encodes to **animated WebP**
   regardless of `Accept` — but **preserves every frame**.
3. Each `ANMF` chunk is rewrapped as a standalone still WebP (~30 lines) and converted
   with macOS `sips`.
4. A pure-Python PNG decoder (~40 lines, `zlib` only) reads the pixels.
5. Frame 0 is the background plate; frames 1..n are deltas whose `ANMF` header carries
   an x/y offset. Union the non-transparent pixels of the delta frames per 32px tile.

## Results

| image | canvas | frames | decoded effect extent |
|---|---|---|---|
| `Berserk1.gif` | 5×5 tiles | 10 | **3×3**, centred |
| `Avalanche1.gif` | 9×9 | 11 | **7×7** block, centred |
| `Great fireball1.gif` | 11×9 | 32 | ball ≈7 across, **plus a missile tail** |

The per-tile signal is sharply bimodal — untouched tiles score **exactly 0**, affected
ones thousands — so classification is unambiguous on these samples.

### One genuine known-answer validation

`Berserk` decodes to a 3×3, and the wiki's own tile data for the creature ability
`Berserk` is `3x3spell`, also 3×3. They agree.

This also corrects an earlier mistake: a previous check called these "disagreeing,
3×3 vs 5×5". That compared the pattern against the image's **canvas** size rather than
its **effect extent**. The canvas carries a one-tile margin; the effect is 3×3.

## Complications, all found by prototyping rather than reasoning

1. **Projectiles contaminate the area.** `Great fireball1.gif` animates the missile
   flying in from the left, leaving a tail on row 4 that is not part of the blast. The
   counts separate it (1318/2926 against ~3847), so a threshold can, but this is
   per-image judgement rather than a clean binary.
2. **The output is a binary mask.** Creature-ability grids distinguish effect, caster,
   target and extra sprites (`0`–`8`); pixel decoding gives only affected/unaffected.
   Spell grids would therefore be **less** informative than ability grids, and should
   not be presented in the same shape as though they carried the same information.
3. **`sips` is macOS-only.** CI runs `pnpm test`, not `build-index`, so an index built
   on a maintainer's Mac is fine today — but this would be the first build step that
   cannot run on Linux. Making it portable means a WebP decoder dependency, which the
   project has so far avoided entirely.

## Honest limits

Three images of roughly 34. These are hand-uploaded animations (`Berserk1.gif` dates
from 2008), not generated from tile data, so conventions may vary across the set.
Only one has an independently known answer. The threshold used here sums pixels across
frames and compares against a single-frame fraction — it classifies correctly only
because the separation is enormous; real use needs per-frame normalisation.

## Recommendation

Worth doing, but scope it honestly: ~34 spells against 1,748 abilities already
covered, a binary mask rather than a labelled grid, and a macOS-only build step. If it
proceeds, the plan must decide the projectile rule, state the reduced information
content in the output shape, and measure the decode against every one of the ~34
images rather than three.

---

## Full-corpus run, and a finding that changes the recommendation

Ran the decoder over **all 30** area images rather than three, then tried to validate
the output. The mechanics hold up; the semantics do not.

### Mechanics: 30/30 decoded

Every image decoded without failure. No image touches all of its tiles, so the
one-tile margin is a consistent convention. Shapes scale sensibly with spell size:
single-target strikes touch 1 tile, waves 15–24, balls 37–49, large AoEs 73–210.
6 of 30 show the projectile artefact.

### Validation: weak, and the oracle is unreliable

Seven decoded spells share a name with a creature ability that carries wiki tile data.
Comparing effect extents: **2 of 7 agree** (`Berserk` 3×3, `Thunderstorm` 7×7).

The five disagreements are **not** evidence the decoder is wrong — a creature ability
named "Fire Wave" need not be the same size as the player spell of that name. But that
cuts both ways: the cross-check cannot confirm the decoder either. There is no
reliable ground truth for player spell areas anywhere in the wiki's data.

### The stopper: animation extent is not affected area

`Fire wave1.gif` decodes to a 6×4 rectangle. Looking at a single mid-animation frame
shows the effect is plainly a **cone**. Both are "correct": the wave expands outward
over the animation, so the union across frames is the swept rectangle while any one
frame is a cone.

Per-tile counts do not separate the two — every touched tile scores 1,984–6,126 with
no threshold recovering the cone. The information needed is *what the animation means*
— does a spell hit everything it sweeps, or only its final extent? — and that is not
in the pixels. It differs per spell: a static flash (Berserk) and an expanding wave
(Fire Wave) need opposite readings.

## Revised recommendation: do not ship this

The decoder reliably extracts **the tiles an animation touches**. That is not reliably
**the tiles a spell affects**, and nothing available distinguishes them:

- no ground truth to calibrate against (2 of 7 name matches agree, and the oracle is
  itself suspect)
- the union-versus-final-frame question is per-spell and unanswerable from the images
- the output would be a binary mask presented alongside ability grids that carry real
  labelled tile data, inviting readers to trust both equally
- it covers **25 of 211 spells**, against 1,748 abilities already served from actual
  tile data

Shipping plausible-looking grids that cannot be verified is worse than serving none:
an agent cannot tell a derived guess from the wiki's own data, and this server's value
rests on that distinction.

**What would change the answer:** a source of truth for player spell areas — official
documentation, or wiki tile data for spells in the way `Module:SceneBuilder` provides
it for creature abilities. If spell pages ever gain `{{Scene}}` templates, the existing
ability pipeline serves them directly with no image decoding at all.

---

## CORRECTION — the "do not ship" conclusion was wrong; the classifier was broken

Prompted by the user asking whether a more reliable method existed. It does, and
finding it exposed the bug behind the previous section.

### The bug

The classifier treated **any non-transparent pixel** in a delta frame as effect. But
these delta frames **redraw the grey floor tiles**, which are opaque. So for most
images every touched tile read as 100% covered, producing bounding boxes rather than
shapes. `Berserk` only appeared to work because its sprites are dark marks on
transparency — the one case where opacity happens to coincide with effect.

That is why `Fire wave` decoded to a rectangle while the frame plainly showed a cone,
and why "animation extent is not affected area" looked like a semantic dead end. It
was not semantic at all.

### The fix

Classify a pixel as effect when it **differs from the background plate** (frame 0)
beyond a tolerance, and threshold each tile relative to the most-covered tile in that
frame, since sprite density varies. No new dependencies.

### Result: 30 images collapse to 12 coherent shape families

| shape | tiles | images |
|---|---:|---|
| `1×1` | 1 | **8** — every single-target strike |
| `7×7` circle | 37 | **7** — Avalanche, Divine caldera, Great fireball, Groundshaker, Mass heal, Stone shower, Thunderstorm |
| `5×4` cone | 12 | **3** — Fire wave ×2, Ice wave |
| `3×3` | 9 | 2 — Berserk, Challenge |
| `1×5` line | 5 | 2 — Energy beam ×2 |
| `3×5` | 11 | 2 — Energy wave ×2 |
| 6 further shapes | | 1 each — Eternal winter, Hell's core, Rage of the skies, Front Sweep, Great energy beam ×2 |

### Why this is good evidence, absent an oracle

There is still no external ground truth for player spell areas. What there is:

1. **Convergence.** Seven independently drawn images produce a **cell-for-cell
   identical** 37-tile circle. Eight produce an identical single tile. Noise does not
   converge.
2. **Before/after pairs agree.** Art redrawn years apart (`Fire wave1.gif` vs
   `Fire wave1(after winter update 2007).gif`, and both `Energy strike` and
   `Energy wave` pairs) decodes to the same shape.
3. **Shapes match what the images show.** Verified by eye: the cone is a cone, the
   circle is a circle.
4. **Families match spell semantics.** Strikes hit one tile; waves are cones; balls
   are circles; beams are lines.

The earlier name-matched cross-check against creature-ability grids remains a **poor
oracle** and should not be used: a creature ability named "Avalanche" is a
single-target strike (`7sqmstrike`), while the player's Avalanche rune is a 7×7
circle. They are different things that share a name. 0 of 7 match cell-for-cell, and
that is expected rather than alarming.

## Revised recommendation: viable, worth building

Caveats that remain and belong in the plan, unchanged from before:

- covers **25 of 211 spells**
- output is a **binary mask**, not the labelled `0`–`8` grid ability data carries, so
  it must not be served in the same shape or field as `area`
- `sips` is macOS-only, making this the first build step that cannot run on Linux
- provenance should be explicit in the data (`derivedFrom: "animation"`), so an agent
  can tell a decoded shape from the wiki's own tile data
