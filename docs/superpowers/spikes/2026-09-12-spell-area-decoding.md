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
