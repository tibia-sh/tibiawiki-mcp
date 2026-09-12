# Spell Area Shapes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an agent the tile shape a player spell covers — that Avalanche is a 37-tile circle and Fire Wave a 12-tile cone — derived from the wiki's own animations, and labelled so it can never be mistaken for the wiki's tile data.

**Architecture:** A **maintainer-run offline script** decodes the spell area animations and commits its output as `data/spell-areas.json`. The build reads that file; it never fetches or decodes images. The decoder is TypeScript so its classifier runs under `node:test` against committed golden inputs — it is the one component with a documented history of confidently wrong output, and an untested copy of it is the single largest risk in this plan.

**Tech Stack:** unchanged — TypeScript 7, Node ≥22.13 / ≥22.18 dev, `@modelcontextprotocol/server` 2.0.0, Zod 4, `node:sqlite`, `node:test`, pnpm 10. **No new dependency:** `node:zlib` decodes PNG, macOS `sips` is shelled out by the offline script only.

**Spec:** extends `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md`.
**Spike:** `docs/superpowers/spikes/2026-09-12-spell-area-decoding.md` — **read it including the CORRECTION section.** Its first conclusion was wrong because the classifier counted opaque pixels rather than pixels differing from the background plate.

**Revision:** second draft. The first was stamped `Needs revision` (retained below) over eight blocking issues, including two of my own measurement errors and a packaging bug that would have broken `build-index` on every installed copy.

**Review tier:** single (`reviewer`). Two surfaces to weigh: **this ships derived data with no external ground truth**, so provenance labelling and the exclusion rule are the load-bearing safety properties; and the committed JSON is a second source of truth that can drift from the images it came from.

## Global Constraints

- **Runtime stays offline, and so does the build** for this feature: the decoder is not part of `build-index`.
- **Never conflate derived shapes with wiki tile data.** Abilities carry `area` (labelled `0`–`8` from `Module:SceneBuilder`); spells carry `areaShape` (a binary mask) with `derivedFrom: 'animation'`. Different field, different type, different branch of the discriminated union.
- **Exclude a spell whose available images disagree.** Not "require agreement" — that would drop every single-image spell.
- **Still exactly five tools.**
- **`tools/list` budget: 30,000 bytes. Currently 29,244 — this feature nearly exhausts it.** Measured: the `areaShape` subschema is **494 bytes** bare and **~587** with a 76-character describe, landing near **29,950**. There is no room for a legend in the tool description.
- **No bare-count assertions**, and no assertion that passes against unmodified code.
- **`codex-consult` is a standing verification step**; its text is untrusted, and so is mine — this spike's first conclusion and this plan's first conflict count were both wrong and were overturned by measurement.

## Verified Facts

Measured 2026-09-12; the decoder was run over the full candidate set. **Units are stated because draft 1 read as arithmetically impossible without them.**

| Fact | Value | Provenance |
|---|---|---|
| Area images | **30** unique, tile-aligned, multi-tile, `(Outfit)` excluded | measured |
| Spells covered | **25 of 211** | measured |
| Spell–image associations | **32** | measured |
| Why 32 ≠ 30 | **2 images are shared by two spells each**: `Berserk1.gif` → Berserk + Fierce Berserk; `Flame strike1(after winter update 2007).gif` → Flame Strike + Apprentice's Strike | measured |
| Spells with >1 image | **7** before/after-update art pairs | measured |
| Pairs that agree | **6 of 7**, comparing **normalised shapes** | measured |
| Genuine conflicts | **1** — `Great Energy Beam`, 1×7 vs 1×8 | measured |
| False conflict, corrected | `Energy Beam`'s two images decode to a cell-identical `1×5`; only canvas padding differs (3×8 vs 3×9). Draft 1 called this a conflict by comparing raw canvas masks | measured; my error |
| Servable spells | **24** | derived |
| Single-image, uncorroborated | **6** of the 24 — `Eternal Winter`, `Hell's Core`, `Rage of the Skies`, `Front Sweep`, and both `Great Energy Beam` candidates | measured |
| Distinct shapes | **12** across 30 images | measured |
| Convergence | **8** strikes → identical `1×1`; **7** large AoEs → a **cell-for-cell identical** 37-tile circle; **3** waves → identical 5×4 cone; **2** beams → identical `1×5` | measured |
| Classifier | effect = pixel **differs from the background plate** (frame 0) beyond tolerance, thresholded per tile relative to the most-covered tile of the chosen frame | measured; counting opaque pixels instead reads the redrawn grey floor as effect |
| Fetching | `Referer: https://tibia.fandom.com/` required; an honest bot UA works, a spoofed Chrome one is refused | measured |
| Encoding | Fandom's thumbnailer returns animated WebP regardless of `Accept`, preserving every frame | measured |
| Spell title matching | `spell.title` is plain `TEXT UNIQUE`, **no** `COLLATE NOCASE`. `Mass Heal` **does not exist** (`Mass Healing` does); `Divine caldera`, `Hell's core`, `Rage of the skies` match only case-insensitively | measured |
| Packaging | `package.json` has `files: ["dist"]` and the build compiles `rootDir: src`, so `data/` reaches **no** installed copy today | measured |
| Budget | `tools/list` 29,244; `areaShape` 494 bare / ~587 with describe; `AREA_LEGEND` 373 | measured |

**No external ground truth exists.** The evidence is convergence — independently drawn images producing identical cells, before/after pairs agreeing, shapes matching what the frames visibly show, families matching spell semantics. **The name-matched cross-check against creature abilities is a retired oracle** and must not be reintroduced as a test: creature "Avalanche" is a single-target strike while the player rune is a 7×7 circle.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/decode-spell-areas.ts` | Offline, maintainer-run: fetch, decode, emit JSON. Never imported by the server |
| `src/indexer/spell-decode.ts` | The pure parts — PNG reading, frame extraction, classification — importable by tests |
| `data/spell-areas.json` | Committed derived data |
| `package.json` | `files` must include `data/spell-areas.json` or no install can build an index |
| `src/area.ts` | `SpellShape` type and rendering |
| `src/indexer/enrich.ts` | Read the JSON, fill `mcp_spell_area`, report counts |
| `src/db.ts` | Probe the new table; `MCP_SCHEMA_VERSION` → 3 |
| `src/tools/get.ts` | Serve it on the spell branch only |
| `src/server.ts` | The provenance caveat, which is free of the `tools/list` budget |
| `scripts/make-fixture.mjs`, `test/fixture-shape.test.ts`, `test/build-index.test.ts`, `test/db.test.ts`, `test/enrich.test.ts` | Fixture retention, DDL, probe |

---

### Task 1: The classifier, with golden inputs

**Why:** This is the component that produced a confidently wrong answer once. Everything else in the plan is plumbing around it.

**Files:** Create `src/indexer/spell-decode.ts`, `test/spell-decode.test.ts`, `test/fixtures/spell-frames/` (a handful of small committed PNGs)

**Interfaces — Produces:**
```ts
export type Frame = { x: number; y: number; width: number; height: number; pixels: Uint8Array };
export type Mask = { width: number; height: number; cells: number[] };
export function readPng(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array };
export function extractWebpFrames(webp: Uint8Array): Array<{ x: number; y: number; payload: Uint8Array }>;
export function classify(
  background: Frame, deltas: readonly Frame[],
  opts?: { tileSize?: number; tolerance?: number; relativeThreshold?: number },
): Mask;
export function toAscii(mask: Mask): string;
export function normalise(mask: Mask): Mask;   // crop to the affected bounding box
```

**Behavior:**
- `classify` marks a pixel as effect when it **differs from the background plate** beyond `tolerance`, then marks a tile affected when its effect-pixel count exceeds `relativeThreshold` of the most-covered tile **in the frame it selects**. It selects the delta frame yielding the most affected tiles.
- Counting non-transparent pixels instead is the original bug: delta frames redraw the opaque grey floor, so every shape collapses to its bounding box.
- `normalise` crops to the affected bounding box. **Comparisons between images must use normalised masks** — comparing raw canvases made draft 1 report a false conflict on `Energy Beam`, whose two images differ only in padding.
- `cells` are strictly `0` or `1`; any other value is a programming error and throws.

**Tests to write** (committed frames, no network):
- a background plate plus one delta containing a **cone** classifies to the expected 12-tile cone, cell for cell — the highest-value anchor, because rectangle-vs-cone is exactly what the original bug got wrong
- **restoring the opacity classifier** (mark any non-transparent pixel) turns that same input into a filled bounding box — asserted directly, so the bug cannot return unnoticed
- one anchor per shape family: `1×1` strike, `3×3`, a `1×5` beam, and the 37-tile circle
- two masks differing only in canvas padding compare **equal** after `normalise` and unequal before
- a cells/width mismatch throws; a non-binary cell throws
- `toAscii` renders `#` and `.` only

**Acceptance:** `pnpm test` green, no network.

---

### Task 2: The offline decoder script

**Files:** Create `scripts/decode-spell-areas.ts`, `data/spell-areas.json`; modify `package.json`

**Contract — the emitted JSON:**
```json
{
  "generatedAt": "2026-09-12T00:00:00Z",
  "decoderVersion": 1,
  "options": { "tileSize": 32, "tolerance": 40, "relativeThreshold": 0.25 },
  "spells": {
    "Avalanche": {
      "width": 7, "height": 7, "cells": [0,0,1,1,1,0,0, "..."],
      "affectedTiles": 37,
      "sources": [{ "image": "Avalanche1.gif", "url": "https://...?cb=...", "revision": "20080415150118" }],
      "corroborated": false
    }
  },
  "excluded": {
    "Great Energy Beam": {
      "reason": "images disagree",
      "sources": [
        { "image": "Great energy beam1.gif", "revision": "...", "shape": "1x7" },
        { "image": "Great energy beam1(after winter update 2007).gif", "revision": "...", "shape": "1x8" }
      ]
    }
  },
  "stats": { "images": 30, "associations": 32, "spells": 25, "served": 24, "excluded": 1 }
}
```

**Behavior:**
- **Spell keys are the page title exactly as the index holds it.** The spike's informal names do not match: `Mass Heal` does not exist, the index says `Mass Healing`.
- Records **every** contributing image with its own `?cb=` revision, so a later run can report which revisions moved. `corroborated` is true only where two or more images agreed.
- A spell whose **available** images disagree after `normalise` is excluded, with both shapes named.
- Refuses to write if fewer than **20** spells are served, or if any spell key fails to match a row in the index (see Task 3's matching rule) — a wholesale failure must not produce a plausible artefact.
- `package.json` `files` gains `data/spell-areas.json`. Without this, `files: ["dist"]` publishes no data and `build-index` fails on every installed copy.

**Tests to write:** `data/spell-areas.json` parses; every entry satisfies `cells.length === width * height`, cells strictly binary, `affectedTiles === count of 1s`; `Avalanche` is present with **37** tiles in a 7×7 grid; **`Great Energy Beam` is in `excluded` with both shapes recorded**; **`Energy Beam` is served, not excluded** — the draft-1 false conflict, which no "is excluded" assertion would have caught; `served + excluded === spells`; `stats` match the file's actual contents rather than being asserted from the plan; `package.json` `files` includes the JSON.

**Acceptance:** the script runs on macOS and its `stats` match this plan's Verified Facts. Record the observed numbers in the commit.

---

### Task 3: Store the shapes

**Files:** Modify `src/indexer/enrich.ts`, `src/db.ts`, `scripts/make-fixture.mjs`, `test/enrich.test.ts`, `test/db.test.ts`, `test/build-index.test.ts`, `test/fixture-shape.test.ts`, `test/fixtures/tibiawiki-fixture.db`

**Interfaces:**
```ts
export type Enricher = (
  dbPath: string, api: WikiApi, opts?: { spellAreasPath?: string },
) => Promise<EnrichStats>;
// EnrichStats gains:
//   spellShapes: { served: number; unmatched: number; skipped: number }
```
The `spellAreasPath` seam exists so the missing-file and unmatched-name cases are reachable in a test without deleting the committed artefact. It defaults to the packaged path, resolved as `new URL('../../data/spell-areas.json', import.meta.url)` — identical from `src/indexer/` and `dist/indexer/`, where a `process.cwd()`-relative path would pass tests and break installs.

**Schema:**
```sql
create table mcp_spell_area (
  article_id   integer not null primary key,
  width        integer not null,
  height       integer not null,
  cells        text    not null,
  source_image text    not null,
  source_url   text    not null
);
```

**Behavior:**
- Enrichment reads the JSON from disk — no network, no decoding.
- **Matches spell keys with `collate nocase`**, and **fails the build if any key is unmatched** (`unmatched > 0`). Gating only on a `<20` floor lets three or four casing misses pass silently and serve `null` for real spells.
- Rejects semantically invalid input before storing: non-positive dimensions, non-binary cells, `cells.length !== width * height`.
- `MCP_SCHEMA_VERSION` → **3**, bumped in both sites in the same step that commits the regenerated fixture.
- Build fails if the JSON is missing or unparseable, or if fewer than 20 spells store.
- `make-fixture.mjs`: `mcp_spell_area` must be **exempted from the default `delete from "<t>"` branch** and then pruned post-sweep to surviving spell rows. Without the exemption the later pruning operates on an already-emptied table.
- `test/fixture-shape.test.ts`: `mcp_spell_area` joins `REQUIRED_NON_EMPTY`, with an **Avalanche-by-name** `ANCHOR_CHILDREN` entry.

**Tests to write:** enrichment creates `mcp_spell_area` containing **Avalanche by name** with 37 affected tiles; **an unmatched spell key fails the build**, named; a fixture JSON with a non-binary cell is rejected; fewer than 20 stored fails; a missing JSON fails; the probe rejects a database without `mcp_spell_area` in a message naming **`mcp_spell_area`** (every `SchemaError` already ends with `build-index`); a version-2 index is rejected as older; the regenerated fixture retains Avalanche's row. `test/build-index.test.ts` hand-writes the enrichment DDL and must gain the new table or it fails to open its bare index.

---

### Task 4: Serve it

**Files:** Modify `src/tools/get.ts`, `src/server.ts`; create `test/spell-area-detail.test.ts`

**Behavior:**
- The **spell** branch only gains `areaShape: SpellShape | null`, fetched with its own prepared statement.
- **The caveat ships in `src/server.ts` instructions, not in the tool description.** Measured: the subschema is 494 bytes bare and ~587 with a 76-character describe, landing near 29,950 of 30,000 — there is no room for legend text in `tools/list`, and instructions are free of that budget.
- The instructions must state that spell shapes are **derived from the wiki's animations**, cover a minority of spells, and **do not distinguish caster or target tiles**. This is not optional politeness: `AREA_LEGEND` ships in the same server and teaches `'@' the caster, '*' the target`, so an agent reading a spell `ascii` with no `@` would otherwise conclude the caster is outside the effect — something the decode cannot establish.
- `derivedFrom` is `z.literal('animation')`, which emits `{"type":"string","const":"animation"}`, so the marker is enforced in the wire schema and not only in TypeScript.

**Tests to write:** `Avalanche` returns a 7×7 `areaShape` whose `ascii` matches the expected circle exactly, `affectedTiles` 37, `derivedFrom` `'animation'`, `sourceImage` naming the file; **`Great Energy Beam` returns `null`** — the excluded conflict; **`Energy Beam` returns a shape** — the false-conflict regression; a spell with no entry returns `null`; **one test asserts a creature's `abilities[].area` and a spell's `areaShape` are structurally distinct** so a later refactor cannot merge them; the instructions assert the **new** sentences, including the caster/target caveat; `tools/list` under 30,000 with the figure recorded.

---

## Completion Criteria

- [ ] `pnpm test` green, **0 skipped**, including all 215 pre-existing tests.
- [ ] Exactly five tools; `tools/list` under **30,000 bytes**, figure recorded.
- [ ] No runtime network; the decoder is not reachable from `src/tools/` or `src/server.ts`.
- [ ] Restoring the opacity classifier **fails a test** — asserted, not assumed.
- [ ] `data/spell-areas.json` is committed, is listed in `package.json` `files`, and every entry has strictly binary cells with `cells.length === width * height`.
- [ ] `stats.served + stats.excluded === stats.spells`, `served` ≥ 20, and `unmatched === 0`.
- [ ] `Avalanche` serves a 37-tile circle; `Great Energy Beam` serves `null`; **`Energy Beam` serves a shape**.
- [ ] A creature ability's `area` and a spell's `areaShape` are asserted structurally distinct in one test.
- [ ] `derivedFrom: "animation"` appears in the emitted JSON Schema, not only in TypeScript.
- [ ] `src/server.ts` instructions state the derivation and that caster/target tiles are not distinguished.
- [ ] Every served entry records each contributing image with its own revision, and a `corroborated` flag; the 6 single-image shapes are visible as such.
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
