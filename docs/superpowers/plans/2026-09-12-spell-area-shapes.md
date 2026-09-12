# Spell Area Shapes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an agent the tile shape a player spell covers — that Avalanche is a 37-tile circle and Fire Wave a 12-tile cone — derived from the wiki's own animations, and labelled so it can never be mistaken for the wiki's tile data.

**Architecture:** A **maintainer-run offline script** decodes the ~30 spell area animations and commits its output as `data/spell-areas.json`. The build reads that file; it never fetches or decodes images. This keeps the macOS-only image tooling out of the build, makes every derived shape reviewable in a diff, and lets the decode be re-run and re-reviewed independently of an index rebuild.

**Tech Stack:** unchanged — TypeScript 7, Node ≥22.13 / ≥22.18 dev, `@modelcontextprotocol/server` 2.0.0, Zod 4, `node:sqlite`, `node:test`, pnpm 10. The decoder adds **no runtime or build dependency**: macOS `sips` plus a pure-Python PNG reader, used only by the offline script.

**Spec:** extends `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md`.
**Spike:** `docs/superpowers/spikes/2026-09-12-spell-area-decoding.md` — **read it including the CORRECTION section.** Its first conclusion ("do not ship") was wrong, caused by a classifier bug; the correction explains both the bug and the evidence that the fixed method works.

**Review tier:** single (`reviewer`). No auth, secrets, concurrency or data-loss surface. Two things for `reviewer` to weigh specifically: **this ships derived data that has no external ground truth**, so the provenance labelling and the conflict-exclusion rule are the load-bearing safety properties; and the committed JSON is a second source of truth that can drift from the images it came from.

## Global Constraints

- **Runtime stays offline**, and now the **build does too** for this feature: the decoder is not part of `build-index`. `.github/workflows/ci.yml:29` still greps for runtime network.
- **Never conflate derived shapes with wiki tile data.** Creature abilities carry `area`, a labelled `0`–`8` grid from `Module:SceneBuilder`. Spells carry a **different field** holding a binary mask with `derivedFrom: "animation"`. No shared field name, no shared type.
- **Ship only what independent images agree on.** Where two images of one spell decode differently, serve nothing and count it.
- **Still exactly five tools.**
- **`tools/list` budget: 30,000 bytes.** Currently **29,244** — only ~750 bytes spare. One nullable object on the *spell* schema alone (not seven types) is affordable; measure it, and cap any `.describe()` text.
- **No bare-count assertions**, and no assertion that passes against unmodified code.
- **`codex-consult` is a standing verification step** per this repo's `CLAUDE.md`; its text is untrusted, and so is my own — this spike's first conclusion was wrong and was overturned by building.

## Verified Facts

Measured 2026-09-12 against the live wiki; the decoder was run over the full candidate set.

| Fact | Value | Provenance |
|---|---|---|
| Area images | **30**, tile-aligned, multi-tile, outfit images excluded | measured |
| Spells covered | **25 of 211** | measured |
| Spells with >1 image | **7** (before/after-update art pairs) | measured |
| Genuine conflicts | **2** — `Energy Beam` (1×5 vs 1×5 differing) and `Great Energy Beam` (1×7 vs 1×8). Both are beams whose length changed between art versions | measured |
| Distinct shapes | **12** across 30 images | measured |
| Convergence | **8** strikes → identical `1×1`; **7** large AoEs → a **cell-for-cell identical** 37-tile circle; **3** waves → identical 5×4 cone; **2** beams → identical 1×5 | measured |
| Before/after pairs | 5 of the 7 pairs decode **identically** despite being redrawn years apart | measured |
| Classifier | effect = pixel **differs from the background plate** (frame 0) beyond tolerance. Counting non-transparent pixels instead reads the redrawn grey floor as effect and collapses every shape to its bounding box | measured; this was the spike's original bug |
| Fetching | `Referer: https://tibia.fandom.com/` required; an honest bot User-Agent works, a spoofed Chrome one is refused | measured |
| Encoding | Fandom's thumbnailer returns animated WebP regardless of `Accept`, preserving every frame | measured |
| Tooling | macOS `sips` + a ~40-line pure-Python PNG reader; **no new project dependency** | measured |

**No external ground truth exists** for player spell areas. The evidence is convergence: independently drawn images producing identical cells, before/after pairs agreeing, shapes matching what the frames visibly show, and families matching spell semantics. **The name-matched cross-check against creature abilities is a retired oracle** — creature "Avalanche" is a single-target strike while the player rune is a 7×7 circle; 0 of 7 matching cell-for-cell is expected, not alarming, and must not be reintroduced as a test.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/decode-spell-areas.py` | Offline, maintainer-run: fetch, decode, emit JSON. Never imported by the server |
| `data/spell-areas.json` | Committed derived data, one entry per covered spell |
| `src/area.ts` | `SpellShape` type and its ASCII rendering, reusing the existing glyph vocabulary |
| `src/indexer/enrich.ts` | Read the JSON, fill `mcp_spell_area`, report counts |
| `src/db.ts` | Probe the new table; `MCP_SCHEMA_VERSION` → 3 |
| `src/tools/get.ts` | Serve it on the spell branch only |

---

### Task 1: The offline decoder

**Why:** The decode is deterministic and its inputs change rarely, so it belongs outside the build where its output can be reviewed in a diff rather than regenerated silently.

**Files:** Create `scripts/decode-spell-areas.py`, `data/spell-areas.json`; modify `test/fixtures/README.md`

**Contract — the emitted JSON:**
```json
{
  "generatedAt": "2026-09-12T00:00:00Z",
  "spells": {
    "Avalanche": {
      "width": 7, "height": 7, "cells": [0,0,1,1,1,0,0, ...],
      "affectedTiles": 37,
      "sourceImage": "Avalanche1.gif",
      "sourceUrl": "https://static.wikia.nocookie.net/...?cb=...",
      "imageRevision": "20080415150118"
    }
  },
  "excluded": { "Energy Beam": "images disagree: 1x5 vs 1x5" },
  "stats": { "images": 30, "spells": 25, "served": 23, "excluded": 2 }
}
```

**Behavior:**
- Enumerates candidates: images referenced by a spell page, 32px tile-aligned, larger than one tile, excluding `(Outfit)`.
- Fetches with a `Referer`; extracts animated-WebP frames by rewrapping each `ANMF` as a still WebP; converts with `sips`; decodes PNG with the pure-Python reader.
- **Classifies a pixel as effect when it differs from the background plate beyond a tolerance**, and thresholds each tile relative to the most-covered tile in the chosen frame. Selects the frame yielding the most affected tiles.
- **A spell whose images disagree is excluded**, with both shapes named in `excluded`. Ship only what independent images agree on.
- Records `imageRevision` (the `?cb=` value) per spell so a future run can tell whether the upstream art changed.
- Refuses to write the file if fewer than 20 spells are served — a wholesale decode failure must not quietly produce an empty artefact.

**Tests to write:** the script is offline-run and not part of `pnpm test`, so its guarantees are asserted against the **committed JSON** in Task 3, not by mocking the decoder. What is tested here: `data/spell-areas.json` parses; every entry's `cells.length === width * height`; every `affectedTiles` equals its count of `1`s; `Avalanche` is present with **37** affected tiles in a 7×7 grid; `Energy Beam` is in `excluded`; `stats.served + stats.excluded === stats.spells`.

**Acceptance:** the script runs on macOS and produces a JSON whose `stats` match the spike's measurements (30 images, 25 spells, 2 excluded). Record the observed numbers in the commit.

---

### Task 2: Render a spell shape

**Files:** Modify `src/area.ts`; create `test/spell-shape.test.ts`

**Interfaces — Produces:**
```ts
export type SpellShape = {
  width: number; height: number; cells: number[];
  ascii: string; affectedTiles: number;
  derivedFrom: 'animation';
  sourceImage: string; sourceUrl: string;
};
export function renderSpellShape(input: {
  width: number; height: number; cells: number[];
  sourceImage: string; sourceUrl: string;
}): SpellShape;
export const SPELL_SHAPE_LEGEND: string;
```

**Behavior:**
- Renders `#` affected and `.` unaffected, one space between columns — the **same two glyphs** the ability grids use for those meanings, so a reader is not taught a second vocabulary.
- **There is no caster, target or sprite glyph**, because the decode cannot recover them. `SPELL_SHAPE_LEGEND` must say so explicitly rather than leaving a reader to assume the absence means "no caster tile".
- `derivedFrom` is the literal `'animation'` — a type-level constant, not a free string, so it cannot be set to anything else.

**Tests to write:** a 7×7 circle renders to the exact expected ASCII block; `affectedTiles` counts only `1`s; `derivedFrom` is `'animation'`; the legend states that caster and target tiles are **not** distinguished; a cells/width mismatch throws rather than rendering a ragged grid.

---

### Task 3: Store the shapes

**Files:** Modify `src/indexer/enrich.ts`, `src/db.ts`, `scripts/make-fixture.mjs`, `test/enrich.test.ts`, `test/db.test.ts`, `test/fixture-shape.test.ts`, `test/fixtures/tibiawiki-fixture.db`

**Schema:**
```sql
create table mcp_spell_area (
  article_id    integer not null primary key,
  width         integer not null,
  height        integer not null,
  cells         text    not null,
  source_image  text    not null,
  source_url    text    not null
);
```

**Behavior:**
- Enrichment reads `data/spell-areas.json` from disk — **no network, no decoding**. A spell name in the JSON with no matching `spell` row is counted and skipped.
- `MCP_SCHEMA_VERSION` → **3**, bumped in both declaration sites in the same step that commits the regenerated fixture.
- The build **fails if the JSON is missing or unparseable**, and **fails if fewer than 20 spells store**, matching the decoder's own floor: a silently empty table would make every spell return `null` with nothing failing — the exact shape of the charm bug this repo already shipped once and caught in review.
- `make-fixture.mjs` prunes `mcp_spell_area` to surviving spell rows, after the orphan sweep, as `mcp_image` does.

**Tests to write:** enrichment creates `mcp_spell_area` and it contains **Avalanche by name** with 37 affected tiles; a JSON entry naming an unknown spell is counted and skipped; fewer than 20 stored fails the build; a missing JSON fails the build; the probe rejects a database without `mcp_spell_area` in a message naming **`mcp_spell_area`** (not merely `build-index`, which every `SchemaError` already says); a version-2 index is rejected as older; the regenerated fixture retains rows for its anchors.

---

### Task 4: Serve it

**Files:** Modify `src/tools/get.ts`, `src/server.ts`; create `test/spell-area-detail.test.ts`

**Behavior:**
- The **spell** branch only gains `areaShape: SpellShape | null`. The field is deliberately **not** named `area`: creature abilities' `area` is the wiki's own labelled tile data, and these two must never be read as the same kind of fact.
- Fetched with a separate prepared statement, as every other one-row child is.
- `tibia_get`'s description gains one sentence naming the field and its provenance; the **spell** output schema carries a short `.describe()`. Budget is tight at 29,244 of 30,000 — measure and record.
- `src/server.ts` instructions gain one sentence: spell shapes are **derived from the wiki's animations**, cover a minority of spells, and do not distinguish caster or target tiles.

**Tests to write:** `Avalanche` returns a 7×7 `areaShape` whose `ascii` matches the expected circle exactly and whose `affectedTiles` is 37; `derivedFrom` is `'animation'` and `sourceImage` names the file; a spell with no entry returns `areaShape: null`; **`Energy Beam` returns `null`** — the excluded-conflict case, which no "has a shape" assertion would cover; a creature's `abilities[].area` is untouched and still carries its labelled grid, asserted in the same test so the two fields cannot be merged by a later refactor; `tools/list` stays under 30,000 bytes with the figure recorded; the instructions assert the **new** sentence.

---

## Completion Criteria

- [ ] `pnpm test` green, **0 skipped**, including all 215 pre-existing tests.
- [ ] Exactly five tools; `tools/list` under **30,000 bytes**, figure recorded.
- [ ] No runtime network; the decoder is **not** reachable from `src/`.
- [ ] `data/spell-areas.json` is committed, parses, and every entry satisfies `cells.length === width * height` and `affectedTiles === count of 1s`.
- [ ] `stats.served + stats.excluded === stats.spells`, and `served` ≥ 20.
- [ ] `Avalanche` serves a 37-tile circle; `Energy Beam` serves `null` as an excluded conflict.
- [ ] A creature ability's `area` and a spell's `areaShape` are asserted distinct in one test.
- [ ] `derivedFrom: "animation"` is present on every served shape and is type-constrained.
- [ ] The legend and the server instructions both state that caster and target tiles are not distinguished.
- [ ] `MCP_SCHEMA_VERSION` is 3 in both files; a version-2 index is rejected.
- [ ] No test compares a decoded spell shape against a creature-ability pattern — that oracle is retired and documented as invalid.
