# Spell-frame fixtures

**Generated** — every `*-plate.png` and `*-delta.png` here is written by
`scripts/make-golden-frames.ts`. Do not hand-edit them; regenerate instead.

They encode one invariant deliberately: **each delta frame is fully opaque across
the canvas**, painting the floor colour everywhere except the effect cells. That
mirrors how TibiaWiki's animations actually work, and it is what makes the
opacity-regression test in `test/spell-decode.test.ts` meaningful. A fixture with a
transparent background would let the broken classifier produce the right answer.

## `berserk1.webp` — third-party content

Not generated. It is `File:Berserk1.gif` from TibiaWiki, served as WebP by Fandom's
thumbnailer and committed verbatim.

- Source page: https://tibia.fandom.com/wiki/File:Berserk1.gif
- TibiaWiki text and pages are licensed CC BY-SA.
- The artwork itself is **copyright CipSoft GmbH**. Tibia is made by CipSoft; this
  project is unaffiliated with and not endorsed by CipSoft.

It is included solely as a test fixture for `extractWebpFrames`, which needs a
container this repository did **not** write: a synthesised one would encode the same
frame-offset convention on both sides of the assertion and could agree on a wrong
answer. It is excluded from the published npm package (`files` ships only `dist/`
and `data/spell-areas.json`).
