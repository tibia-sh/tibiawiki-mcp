# Spell Area Shapes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an agent the tile shape a player spell covers — that Avalanche is a 37-tile circle and Fire Wave a 12-tile cone — derived from the wiki's own animations, and labelled so it can never be mistaken for the wiki's tile data.

**Architecture:** A **maintainer-run offline script under `scripts/`** decodes the spell area animations and commits its output as `data/spell-areas.json`. The build reads that file; it never fetches or decodes images. Putting the decoder in `scripts/` rather than `src/` makes its isolation structural — `tsconfig.build.json` has `rootDir: src`, so it cannot reach `dist/`, and the server cannot import it by accident.

**Tech Stack:** unchanged. **No new dependency:** `node:zlib` decodes PNG, macOS `sips` is shelled out by the offline script only.

**Spec:** extends `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md`.
**Spike:** `docs/superpowers/spikes/2026-09-12-spell-area-decoding.md` — **read it including the CORRECTION and the corroboration section.**

**Revision:** third draft. Draft 1 was rejected over eight blockers, draft 2 over three (both stamps retained below). Two of those were arithmetic errors of mine in the facts table; a third was a repeat of the same class. That is why **the Verified Facts below are script output, not prose** — run `node scripts/spell-area-facts.mjs` and paste, never retype.

**Review tier:** single (`reviewer`). Two surfaces: **derived data with no external ground truth**, so provenance and the exclusion rule are load-bearing; and a committed JSON that can drift from its source images.

## Global Constraints

- **Runtime stays offline, and so does the build** for this feature.
- **Never conflate derived shapes with wiki tile data.** Abilities carry `area` (labelled `0`–`8`); spells carry `areaShape` (binary) with `derivedFrom: 'animation'`.
- **Exclude a spell whose available images disagree** — not "require agreement", which would drop every single-image spell.
- **Still exactly five tools.**
- **`tools/list` budget: 30,000. Currently 29,244.** Measured: the `SpellShape` subschema is **~587 bytes** with a 76-character describe, **+49** for `corroborated`, projecting **≈29,880**. There is no room for legend text in the tool description; the caveat ships in `src/server.ts` instructions, which travel at `initialize` and are outside this budget.
- **No bare-count assertions**, and no assertion that passes against unmodified code.
- **`codex-consult` is a standing verification step**; its text is untrusted, and so is mine — three of this plan's own figures were wrong and were caught by review.

## Verified Facts

**Generated.** `node scripts/spell-area-facts.mjs`, run 2026-09-12 against
`docs/superpowers/spikes/2026-09-12-spell-areas-measured.json`:

```
unique area images                 30
spell-image associations           32
spells covered                     25
images shared by two spells        2  (Berserk1.gif, Flame strike1(after winter update 2007).gif)
distinct shapes                    12
excluded (images disagree)         1  (Great Energy Beam)
SERVED                             24
  corroborated by a 2nd image      6
  family-corroborated              14
  wholly uncorroborated            4  (Eternal Winter, Hell's Core, Rage of the Skies, Front Sweep)
```

Facts not derivable from that artefact, each measured directly:

| Fact | Value | Provenance |
|---|---|---|
| Classifier | effect = pixel **differs from the background plate** beyond tolerance, thresholded per tile relative to the most-covered tile of the selected frame | measured; counting opaque pixels reads the redrawn grey floor as effect |
| `Energy Beam` is **not** a conflict | both images give a cell-identical `1×5`; only canvas padding differs (3×8 vs 3×9) | measured |
| Convergence | 8 strikes → identical `1×1`; 7 large AoEs → a cell-for-cell identical 37-tile circle; 3 waves → identical 5×4 cone | measured |
| Fetching | `Referer: https://tibia.fandom.com/` required; honest bot UA works, spoofed Chrome refused | measured |
| Encoding | Fandom's thumbnailer returns animated WebP regardless of `Accept`, preserving every frame | measured |
| Spell titles | `spell.title` is plain `TEXT UNIQUE`, **no** `COLLATE NOCASE`. `Mass Heal` does not exist (`Mass Healing` does); `Divine caldera`, `Hell's core`, `Rage of the skies` match only case-insensitively | measured |
| Packaging | `files: ["dist"]` and `rootDir: src`, so `data/` reaches no installed copy today | measured |
| Typecheck scope | `tsconfig.json` `include` is `["src/**/*.ts","test/**/*.ts","scripts/**/*.mjs"]` — a `.ts` script is **not** typechecked today | measured |
| Budget | `tools/list` 29,244; `SpellShape` ~587 with describe, +49 with `corroborated`; `AREA_LEGEND` 373 | measured |

**No external ground truth exists.** The evidence is convergence. **The name-matched cross-check against creature abilities is a retired oracle** and must not be reintroduced: creature "Avalanche" is a single-target strike while the player rune is a 7×7 circle.

## File Structure

| File | Responsibility |
|---|---|
| `src/area.ts` | `SpellShape`, `renderSpellShape`, `normaliseMask` — the shared rendering, next to `Area` |
| `scripts/spell-decode.ts` | PNG reading, WebP frame extraction, classification. **Offline only**; `rootDir: src` keeps it out of `dist` |
| `scripts/decode-spell-areas.ts` | The runner: fetch, decode, emit JSON |
| `scripts/make-golden-frames.ts` | Generates the test fixtures, so their invariants are enforced by code |
| `tsconfig.json` | `include` gains `scripts/**/*.ts`, or the new code is never typechecked |
| `data/spell-areas.json` | Committed derived data |
| `package.json` | `files` gains `data/spell-areas.json`; a `decode-spell-areas` script entry |
| `src/indexer/enrich.ts` | Read the JSON, fill `mcp_spell_area`, report counts |
| `src/indexer/build-index.ts` | The floors — every existing gate lives here, not in `enrich` |
| `src/db.ts` | Probe the table; `MCP_SCHEMA_VERSION` → 3 |
| `src/tools/get.ts`, `src/server.ts` | Serve it; the provenance caveat |
| `scripts/make-fixture.mjs`, `test/fixture-shape.test.ts`, `test/build-index.test.ts`, `test/db.test.ts`, `test/enrich.test.ts` | Fixture retention, DDL, probe, stub stats |

---

### Task 1: The classifier and its golden inputs

**Why:** This component produced a confidently wrong answer once. Everything else is plumbing around it.

**Files:** Create `scripts/spell-decode.ts`, `scripts/make-golden-frames.ts`, `test/spell-decode.test.ts`, `test/fixtures/spell-frames/`; modify `tsconfig.json`, `src/area.ts`

**Interfaces — Produces:**
```ts
// src/area.ts owns Mask: src/ must never import from scripts/. tsconfig.build.json
// has rootDir: src, so even a type-only import that way is TS6059 and fails
// `pnpm build` — and "fixing" it by relaxing rootDir would destroy the isolation this
// architecture exists for. scripts/ imports Mask from src/area.ts, which compiles clean.
export type Mask = { width: number; height: number; cells: number[] };

// scripts/spell-decode.ts
export type Frame = { x: number; y: number; width: number; height: number; pixels: Uint8Array };
export type ClassifyOptions = { tileSize?: number; tolerance?: number; relativeThreshold?: number };
export function readPng(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array };
export function extractWebpFrames(webp: Uint8Array): Array<{ x: number; y: number; payload: Uint8Array }>;
export function classify(background: Frame, deltas: readonly Frame[], opts?: ClassifyOptions): Mask;

// src/area.ts — rendering lives beside Area, so there is one implementation
export type SpellShape = {
  width: number; height: number; cells: number[];
  ascii: string; affectedTiles: number;
  derivedFrom: 'animation';
  sourceImage: string; sourceUrl: string; corroborated: boolean;
};
export function normaliseMask(mask: Mask): Mask;
export function renderSpellShape(input: {
  width: number; height: number; cells: number[];
  sourceImage: string; sourceUrl: string; corroborated: boolean;
}): SpellShape;
```
`SpellShape` is the exact field list the ~587-byte budget measurement assumes; adding to it re-opens the budget question.

**Behavior:**
- `classify` marks a pixel as effect when it **differs from the background plate** beyond `tolerance`; a tile is affected when its effect-pixel count exceeds `relativeThreshold` of the most-covered tile in the frame it selects; it selects the delta frame yielding the most affected tiles.
- `normaliseMask` crops to the affected bounding box. **All image-to-image comparison uses normalised masks** — comparing raw canvases produced draft 1's false `Energy Beam` conflict.
- `renderSpellShape` emits `#` and `.` only, and throws on a non-binary cell or a `cells.length !== width * height`.

**The golden fixtures, and the invariant that makes them meaningful:**
`scripts/make-golden-frames.ts` generates `test/fixtures/spell-frames/` so the property below is enforced by code rather than left to an implementer's care. **Every generated delta frame must be fully opaque across its rect, painting the floor colour everywhere except the effect cells.** That is the real-world condition the spike's CORRECTION identifies, and precisely the condition `Berserk1.gif` lacked — a transparent-background fixture would make the opacity-regression test pass against a broken classifier and prove nothing.

Generate at minimum: a 7×7 canvas, 32px tiles, one background plate and one delta painting a 12-tile cone; plus one-frame cases for a `1×1` strike, a `3×3`, a `1×5` beam, and the 37-tile circle.

**Tests to write:**
- the cone fixture classifies to the expected 12 cells, cell for cell
- **the same fixture, classified by "any non-transparent pixel", yields a filled bounding box rather than the cone.** This is why the fixture must have opaque deltas. Two ways to express it, neither adding production surface: a five-line helper local to the test file, or `classify(bg, deltas, { tolerance: -1 })` — every opaque pixel then "differs", which is exactly the original bug. **Verified on the real Fire Wave frames: `tolerance: 40` gives the cone, `tolerance: -1` gives the filled 4×6 bounding box.** Do **not** add a predicate option to `ClassifyOptions`; the field list above is what the budget measurement assumes
- an anchor each for `1×1`, `3×3`, `1×5`, and the 37-tile circle
- **a multi-delta case whose frames have different extents**, asserting the selected frame's cells — every other golden uses a single delta, so taking the first frame or unioning all of them would pass them all. The union must differ from the expected winning frame
- two masks differing only in canvas padding are equal after `normaliseMask` and unequal before
- **`extractWebpFrames` on a committed animated WebP returns the expected frame count and each frame's `x`/`y` offset.** Two requirements, or it is vacuous. The fixture must be a **real image fetched from the wiki**, not synthesised by `make-golden-frames.ts` — a synthesised container encodes the same hand-written offset convention on both sides and can agree on a wrong answer, the exact failure this bullet exists to catch (`Berserk1.gif` is 3.6 KB and its deltas carry offsets; CC BY-SA attribution is already in the server notice). And the asserted offsets must be **non-zero on both axes**, since an extractor hardcoding zero passes otherwise — with one classification case whose expected cells change if offsets are ignored
- `renderSpellShape` throws on a non-binary cell and on a length mismatch
- **a test reads `tsconfig.json` and asserts `include` contains `scripts/**/*.ts`** — durable, and failing against the current value `["src/**/*.ts","test/**/*.ts","scripts/**/*.mjs"]`. `test/plugin.test.ts` already parses `.mcp.json` this way. A hand-introduced type error verifies once and leaves nothing behind

---

### Task 2: The offline decoder script

**Files:** Create `scripts/decode-spell-areas.ts`, `data/spell-areas.json`; modify `package.json`

**Invocation:** `pnpm decode-spell-areas <path-to-index.db>` — the index path is an argument because the script validates every spell key against it, and `data/tibiawiki.db` is gitignored so no default can be assumed.

**Contract — the emitted JSON:**
```json
{
  "generatedAt": "2026-09-12T00:00:00Z",
  "decoderVersion": 1,
  "options": { "tileSize": 32, "tolerance": 40, "relativeThreshold": 0.25 },
  "spells": {
    "Avalanche": {
      "width": 7, "height": 7, "cells": [0, 0, 1, "..."],
      "affectedTiles": 37,
      "corroborated": false,
      "sources": [{ "image": "Avalanche1.gif", "url": "https://...?cb=...", "revision": "20080415150118" }]
    }
  },
  "excluded": {
    "Great Energy Beam": { "reason": "images disagree",
      "sources": [{ "image": "...1.gif", "revision": "...", "shape": "1x7" },
                  { "image": "...(after winter update 2007).gif", "revision": "...", "shape": "1x8" }] }
  },
  "stats": { "images": 30, "associations": 32, "spells": 25, "served": 24, "excluded": 1,
             "corroborated": 6, "familyCorroborated": 14, "uncorroborated": 4 }
}
```
`sources` is plural and per-image; `mcp_spell_area` stores only the **first** source's image and url, because the wire `SpellShape` carries one. Per-image revisions stay JSON-only — they exist for drift detection by a maintainer, not for serving. Draft 2's criteria demanded the schema store what it had no column for; this resolves that.

**Behavior:**
- **Spell keys are the page title exactly as the index holds it**, validated against the supplied index with `collate nocase`. The spike's informal names do not match: `Mass Heal` does not exist.
- **Candidate completeness is a precondition, not an outcome.** The inventory derives from the **spell pages' own `[[File:…]]` references**, filtered to 32px-tile-aligned, multi-tile, non-`(Outfit)` images — the same derivation recorded in `docs/superpowers/spikes/2026-09-12-spell-areas-measured.json`, so a divergent inventory surfaces as a stats mismatch against `scripts/spell-area-facts.mjs`. Built first, then decoded. If any known candidate image fails to fetch or decode, it **fails** rather than silently treating the spell as unanimous — losing a disagreeing candidate would turn `Great Energy Beam` from excluded into servable while every count still looked healthy.
- Excludes a spell whose available images disagree after `normaliseMask`, recording both shapes.
- `corroborated` is true only where two or more images of that spell agreed.
- Refuses to write if fewer than **20** spells are served, or if any spell key is unmatched.
- `package.json` `files` gains `data/spell-areas.json`; without it, `files: ["dist"]` means no installed copy can build an index.

**Tests to write — the runner's decision logic, not only its output.** Inspecting an
already-correct JSON cannot detect a runner that stopped comparing masks or silently
dropped a failed candidate, and exclusion is this plan's load-bearing safety property.
With a fake fetcher: two images agreeing **after normalisation but differing in canvas
padding** produce one served entry, not an exclusion; two genuinely disagreeing images
produce an exclusion recording both shapes; **a known candidate that fails to fetch or
decode fails the run and leaves `data/spell-areas.json` byte-identical**, rather than
treating the surviving image as unanimous. Then, against the committed artefact: it parses; every entry has strictly binary cells and `cells.length === width * height` and `affectedTiles === count of 1s`; `Avalanche` present with 37 tiles in 7×7; **`Great Energy Beam` excluded with both shapes recorded**; **`Energy Beam` served** — the draft-1 false-conflict regression; `stats.served + stats.excluded === stats.spells`; `stats` equal what the file actually contains, recomputed by the test rather than copied from this plan; `stats.corroborated + familyCorroborated + uncorroborated === served`; `package.json` `files` includes the JSON.

**Acceptance:** the script runs and its `stats` match `scripts/spell-area-facts.mjs`.
Additionally **each regenerated normalised mask must equal the corresponding mask in
`docs/superpowers/spikes/2026-09-12-spell-areas-measured.json`** — aggregate totals can
hold while individual cells drift, and that artefact is the only regression oracle the
new decoder has. Record both outputs in the commit.

---

### Task 3: Store the shapes

**Files:** Modify `src/indexer/enrich.ts`, `src/indexer/build-index.ts`, `src/db.ts`, `scripts/make-fixture.mjs`, `test/enrich.test.ts`, `test/db.test.ts`, `test/build-index.test.ts`, `test/fixture-shape.test.ts`, `test/fixtures/tibiawiki-fixture.db`

**Interfaces:**
```ts
export type Enricher = (
  dbPath: string, api: WikiApi, opts?: { spellAreasPath?: string },
) => Promise<EnrichStats>;
// EnrichStats gains exactly:
//   spellShapes: { served: number; unmatched: number }
```
`skipped` is deliberately absent — draft 2 declared it and no behaviour produced it. The path defaults to `fileURLToPath(new URL('../../data/spell-areas.json', import.meta.url))`, which resolves identically from `src/indexer/` and `dist/indexer/` (verified). **`fileURLToPath`, not `.pathname`** — the repo's `.pathname` idiom breaks on install paths containing spaces, and this is a packaged read path.

**Schema:**
```sql
-- enrich.ts's DDL drops every mcp_* table before recreating it, so no stale row
-- survives a rebuild. This one joins that list or it is the only table without it.
drop table if exists mcp_spell_area;
create table mcp_spell_area (
  article_id   integer not null primary key,
  width        integer not null,
  height       integer not null,
  cells        text    not null,
  source_image text    not null,
  source_url   text    not null,
  corroborated integer not null
);
```

**Behavior:**
- `enrich` reads the JSON, validates, stores, and **reports** `spellShapes`. **The floors live in `build-index.ts`**, beside `MIN_IMAGE_COVERAGE` and the coverage gate — every existing floor is there and `enrich` only reports.
- `build-index` fails when the JSON is missing or unparseable, when `unmatched > 0`, or when fewer than 20 spells store.
- Rejects before storing: non-positive dimensions, non-binary cells, `cells.length !== width * height`.
- `MCP_SCHEMA_VERSION` → **3**, both sites, in the same step that commits the regenerated fixture.
- `make-fixture.mjs`: `mcp_spell_area` must be **exempted from the default `delete from "<t>"` branch** and then pruned post-sweep; without the exemption the prune runs on an emptied table.
- `test/fixture-shape.test.ts`: `mcp_spell_area` joins `REQUIRED_NON_EMPTY` with an **Avalanche-by-name** `ANCHOR_CHILDREN` entry.
- `test/build-index.test.ts` hand-writes the enrichment DDL and its stub `stats()` helper; both gain `mcp_spell_area` and `spellShapes`, or typecheck fails before any test runs.

**Tests to write:** enrichment creates `mcp_spell_area` containing **Avalanche by name** with 37 affected tiles and its `corroborated` flag; **an unmatched spell key fails the build**, naming it; a JSON with a non-binary cell is rejected; fewer than 20 stored fails; a missing JSON fails; the probe rejects a database without `mcp_spell_area` in a message naming **`mcp_spell_area`**; a version-2 index is rejected as older; the regenerated fixture retains Avalanche's row.

---

### Task 4: Serve it

**Files:** Modify `src/tools/get.ts`, `src/server.ts`; create `test/spell-area-detail.test.ts`

**Behavior:**
- The **spell** branch only gains `areaShape: SpellShape | null`, fetched with its own prepared statement.
- **The caveat ships in `src/server.ts` instructions**, which travel at `initialize` and are outside the `tools/list` budget. It must state that spell shapes are **derived from the wiki's animations**, cover a minority of spells, **do not distinguish caster or target tiles**, and are **not caster-relative** — `AREA_LEGEND` says `'@' the caster`, `'*' the target` and "as the caster faces", and an agent applying that vocabulary to a normalised spell mask would infer both a caster position and a facing the decode cannot establish. It must also define **`corroborated`**: a second image *of the same spell* agrees. Without that, an agent reads `corroborated: false` as "no support at all", which is wrong for 14 of the 24 — their shape is independently produced by other images, just not by a second image of that spell. The 6/14/4 distinction does not fit the schema's byte budget; instructions are outside it and cost nothing.
- `derivedFrom` is `z.literal('animation')`, emitting `{"type":"string","const":"animation"}`, so the marker is enforced in the wire schema.

**Tests to write:** `Avalanche` returns a 7×7 `areaShape` whose `ascii` matches the expected circle exactly, `affectedTiles` 37, `derivedFrom` `'animation'`, `sourceImage` naming the file; **`Great Energy Beam` returns `null`**; **`Energy Beam` returns a shape**; a spell with no entry returns `null`; **one test asserts a creature's `abilities[].area` and a spell's `areaShape` are structurally distinct**; the instructions assert the new sentences including the caster/target **and** facing caveats; `tools/list` under 30,000 with the figure recorded.

---

## Completion Criteria

- [ ] `pnpm test` green, **0 skipped**, including all 215 pre-existing tests.
- [ ] A test asserts `tsconfig.json` `include` covers `scripts/**/*.ts`, failing against its current value.
- [ ] Exactly five tools; `tools/list` under **30,000**, figure recorded (projected ≈29,880).
- [ ] Restoring the opacity classifier **fails a test**, against a fixture whose delta frames are fully opaque.
- [ ] `extractWebpFrames` has an offset assertion against a committed animated WebP.
- [ ] `data/spell-areas.json` is committed, listed in `package.json` `files`, strictly binary, self-consistent.
- [ ] The script's `stats` match `node scripts/spell-area-facts.mjs`: 30 images, 32 associations, 25 spells, **24 served**, **1 excluded**, **6/14/4** corroboration split.
- [ ] `Avalanche` serves a 37-tile circle; `Great Energy Beam` serves `null`; **`Energy Beam` serves a shape**.
- [ ] A creature ability's `area` and a spell's `areaShape` are asserted structurally distinct.
- [ ] `derivedFrom: "animation"` appears in the emitted JSON Schema.
- [ ] `src/server.ts` instructions state the derivation, the missing caster/target distinction, that shapes are not caster-relative, **and** what `corroborated` means.
- [ ] `MCP_SCHEMA_VERSION` is 3 in both files; a version-2 index is rejected.
- [ ] No test compares a decoded spell shape against a creature-ability pattern.
## Review 1 — first draft (2026-09-12)

- **Verdict: Needs revision before implementation**
- Reviewers: plan-final-reviewer; codex-consult (high, 43s, 38820 tokens); grok-consult — on request only, not run
- Tier: **single**, upheld.
- Adopted: none in this stamp. Findings below are the brief for draft 2.

### Blocking — each verified before adoption

1. **The conflict count was wrong, and it was my measurement that was wrong.** Both reviewers caught it. `Energy Beam` is a **false** conflict: both images decode to a cell-identical `1×5` shape and differ only in canvas padding (3×8 vs 3×9), because my check compared raw canvas masks rather than normalised shapes. **One** real conflict remains (`Great Energy Beam`, 1×7 vs 1×8), so **24** spells are servable, not 23, and **6 of 7** art pairs agree, not 5. Every acceptance anchor derived from those numbers was wrong.
2. **The facts table read as arithmetically impossible** because it never stated its units. Reconciled: **25 spells**, **32 spell-image associations**, **30 unique images** — the gap is **2 images shared by two spells each** (`Berserk1.gif` → Berserk + Fierce Berserk; `Flame strike1(after…)` → Flame Strike + Apprentice's Strike). A shared image means that spell's shape is attributed by page reference, not dedicated art, and must be recorded as such.
3. **`data/spell-areas.json` would never reach an installed copy.** `package.json` declares `files: ["dist"]` and the build compiles `rootDir: src`, so nothing under `data/` is published. Task 3 makes a missing JSON a hard build failure, and `tibiawiki-mcp build-index` is the documented user command — every install would fail to build an index. Verified.
4. **Spell-name matching would silently miss.** The spike names spells informally; **`Mass Heal` does not exist in the index at all** (`Mass Healing` does), and `Divine caldera`, `Hell's core`, `Rage of the skies` match only case-insensitively. `spell.title` is plain `TEXT UNIQUE` with no `COLLATE NOCASE`. With a `<20` floor, three or four such misses pass silently and serve `null` for real spells — the charm-shaped failure this repo already shipped once.
5. **The decoder would have no test of any kind.** It is the one component with a documented history of confidently wrong output, and the proposed JSON assertions (`cells.length === width*height`, `affectedTiles === count of 1s`) are invariants its producer satisfies by construction.
6. **`SPELL_SHAPE_LEGEND` had no declared destination, and the existing legend actively mis-teaches the new field.** `AREA_LEGEND` ships in `tibia_get`'s description and says `'@' the caster, '*' the target`; an agent reading a spell `ascii` with no `@` would conclude the caster is outside the effect, which the decode cannot establish. Measured: the `areaShape` subschema is **494 bytes** bare, **~587** with a 76-char describe, landing near **29,950** of 30,000 — under 50 bytes of margin, and `AREA_LEGEND`-sized text in the description would overflow.
7. **Task 3's tests are not implementable against its own contract.** `Enricher` is fixed as `(dbPath, api) => Promise<EnrichStats>`; there is no seam to supply an alternate JSON, so "a missing JSON fails the build" can only be reached by deleting the committed artefact.
8. **"Ship only what independent images agree on" contradicts the coverage.** Taken literally it excludes every single-image spell. The rule is: exclude where *available* images disagree.

### Also to fix

Record every contributing image with its own `?cb=` revision, plus a corroboration flag, since 6 of the 24 served shapes rest on a single un-corroborated decode; validate cells as strictly binary rather than merely counting; add `test/build-index.test.ts` (it hand-writes the enrichment DDL) and `package.json` to the file list; name `mcp_spell_area` in `REQUIRED_NON_EMPTY` with an Avalanche `ANCHOR_CHILDREN` entry, and exempt it from `make-fixture.mjs`'s default `delete from "<t>"` branch before adding post-sweep pruning; gate unmatched JSON entries at **0**.

### Adopted design change

**Write the decoder in TypeScript, not Python.** `node:zlib` is stdlib, so the PNG reader ports directly and `sips` is shelled out either way. This keeps the repo single-language, puts the classifier under `node:test` with committed golden inputs — which is what closes finding 5 — and keeps the served-count floor in one place instead of two languages. The isolation argument for a separate offline script is unaffected.

### Rejected

- **"Serve the newest image with a flag" instead of excluding.** `?cb=` is a file's last-edit timestamp, not a claim about which art depicts the current game, so re-uploaded old art sorts newest. Exclusion stands.

## Review 2 — second draft (2026-09-12)

- **Verdict: Needs revision before implementation**
- Reviewers: plan-final-reviewer; codex-consult (high, 57s, 32719 tokens); grok-consult — on request only, not run
- Adopted: none. `Needs revision` leaves the body untouched.
- **Closure on draft 1's eight:** 5 fully closed (false conflict, packaging, name matching, enrich seam, agree/disagree rule). 3 partial.

### Remaining blocking findings

1. **My corroboration row was wrong for a third time.** Draft 1 said 6 uncorroborated (importing the spike's "6 further shapes", which counts *shapes*); draft 2 repeated 6 while listing four spells plus both `Great Energy Beam` candidates — which are *excluded* and so not among the 24 at all. Measured precisely and recorded in the spike: **6** corroborated by a second image of the same spell, **14** family-corroborated, **4** wholly uncorroborated. A completion criterion depended on the wrong figure.
2. **`SpellShape` is never defined**, yet four Task 4 assertions and the whole 494/587-byte budget argument depend on its exact field list. Separately, the completion criteria require per-image revisions and a `corroborated` flag that the `mcp_spell_area` schema cannot store — both cannot be true.
3. **The golden-frame recipe omits the property that makes the guard non-vacuous.** "Restoring the opacity classifier turns the input into a bounding box" holds only if the committed delta frame **redraws the opaque plate across the canvas** — the real-world condition, and precisely what `Berserk1.gif` lacked. An implementer given only "a delta containing a cone" can build a transparent-background fixture, get a green test, and ship a guard that proves nothing. `classify` also has no predicate seam, so the guard is delivered by the fixture alone.

### Also raised

`extractWebpFrames` is exported with no test and no fixture, and a wrong frame offset shifts every mask with the same signature as the original bug; `scripts/**/*.ts` is outside `tsconfig.json`'s `include`, so the new script would never be typechecked while the suite reports green; `src/indexer/spell-decode.ts` is imported by nothing under `src/` yet ships in `dist`, making the isolation criterion true by accident; `toAscii` duplicates rendering that File Structure assigns to `src/area.ts`; the post-change budget is **29,831**, not "near 29,950"; `EnrichStats.spellShapes.skipped` is declared and never defined; the packaged read path should use `fileURLToPath`, not `.pathname`, which breaks on install paths containing spaces; Task 2 has no invocation contract.

### Root cause worth fixing before a draft 3

Three arithmetic errors in one facts table is a pattern, not bad luck. The table
derives counts across four overlapping sets of near-equal size. A draft 3 should
**generate** those rows from a committed script rather than assert them in prose.

### Gate cap reached

This is the second of at most two gate invocations. A third requires the user's say-so.

## Review 3 — third draft (2026-09-12)

- **Verdict: Ready**
- Reviewers: plan-final-reviewer (**Ready with small improvements**, no blocking issues); codex-consult (high, 35s, 25765 tokens — **Needs revision**, two test-contract gaps); grok-consult — on request only, not run
- Third gate invocation, above the two-round cap, authorised by the user.

### Closure on draft 2's three — both reviewers agree all are closed

1. **Corroboration arithmetic.** Both reviewers **ran `scripts/spell-area-facts.mjs`** and reproduced the plan's cited output exactly: 30 / 32 / 25 / 1 excluded / **24 served**, split **6 / 14 / 4** with the same four named spells. One re-derived the underlying sets independently from the artefact and confirmed all 25 spell keys match `spell.title` exactly.
2. **`SpellShape` + unstorable fields.** Defined with an exact field list; `sources` plural in JSON, single on the wire. The byte projection was reproduced independently against the installed Zod 4: **29,879** against this plan's ≈29,880, and the `+49` for `corroborated` matched exactly.
3. **Golden-frame recipe.** The opaque-delta invariant is what makes the guard non-vacuous, and it is now enforced by a generator rather than left to care.

### Disagreement, and how it was decided

codex raised two blockers the internal reviewer did not: the Task 2 tests inspected the
committed JSON rather than the runner's exclusion logic, and the offset fixture could be
vacuous with all-zero offsets. **Both are correct and both were adopted**, along with
every improvement from the internal review. They are narrow test-contract gaps that
tighten in a sentence each, not design faults — which is why the verdict is `Ready`
with them applied rather than a fourth round.

### Adopted (12)

`Mask` moved to `src/area.ts` — declaring it under `scripts/` and importing it into
`src/area.ts` is **TS6059 and fails `pnpm build`**, reproduced by review, and relaxing
`rootDir` to "fix" it would destroy the isolation this architecture exists for · the
opacity-regression seam named: `classify(…, { tolerance: -1 })` reproduces the original
bug exactly, **verified on the real Fire Wave frames** (40 → cone, −1 → filled bounding
box), with an explicit instruction not to add a predicate option · the WebP offset
fixture must be a **real fetched image** with **non-zero offsets on both axes**, since a
synthesised container would encode the same convention on both sides · a multi-delta
case, since every other golden uses one frame and first-frame or union would pass them
all · runner-level exclusion tests: padding-agreeing, genuinely disagreeing, and a
failed candidate that **fails the run leaving the artefact byte-identical** ·
per-mask drift comparison against the committed artefact, since aggregate stats can hold
while cells move · a durable `tsconfig.json` assertion replacing a hand-introduced type
error · the candidate inventory's derivation named · `drop table if exists` added to the
DDL · `corroborated` defined in the server instructions, because on the wire it is
`false` for 18 spells while only 4 are genuinely uncorroborated.

### Not adopted

- Sweeping `.pathname` → `fileURLToPath` across the test suite. Scoped to the one packaged read path, which is where it matters.
- Collapsing the duplicated `MCP_SCHEMA_VERSION` declaration. A pre-existing wart; expanding scope here is not this plan's job.

### Residual risk, carried into execution

All 24 served shapes rest on 30 masks in a committed spike artefact produced by
prototype code that is **not** in the repo. Task 2's acceptance makes the new decoder
reproduce them exactly — a strong regression gate, not a correctness proof. A residual
prototype bug would be locked in rather than detected, and no external oracle exists.
Budget headroom after this feature is **~121 bytes**; the existing `tools/list`
assertions will catch an overflow loudly.
