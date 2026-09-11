# Image Links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an agent a URL it can fetch for any creature, item, NPC, spell, mount, imbuement or charm — and give a human reading the transcript a picture.

**Architecture:** The existing build-time enrichment pass gains a second step. It resolves each entity's image through the MediaWiki `imageinfo` API (URL and pixel size only — never image bytes), stores them in one additive `mcp_image` table, and `tibia_get` returns both a structured `image` object and an MCP `resource_link` annotated for the human audience. The runtime still makes no network calls and still stores no binaries.

**Tech Stack:** unchanged — TypeScript 7, Node ≥22.13 runtime / ≥22.18 dev, `@modelcontextprotocol/server` 2.0.0, Zod 4, `node:sqlite`, `node:test`, pnpm 10.

**Spec:** extends `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md`.
**Builds on:** `docs/superpowers/plans/2026-09-11-ability-area-grids.md` (merged). This reuses its `WikiApi` client, its enrichment ordering, and its `mcp_schema_version` probe.

**Review tier:** single (`reviewer`). No auth, secrets, concurrency or data-loss surface. Writes go to the generator's temp file behind the existing atomic rename; network stays inside `src/indexer/`, which the CI grep fences. It does redistribute third-party URLs, so licensing and attribution are in scope for review.

## Global Constraints

- **Runtime stays offline.** Every network call lives in `src/indexer/`; `.github/workflows/ci.yml:29` greps for it.
- **Never store image bytes.** URLs and integer dimensions only. The repo ships no binaries beyond the fixture, and `--skip-images` is passed to the generator deliberately.
- **Still exactly five tools.**
- **`tools/list` budget: 30,000 bytes.** Currently **26,262**. This plan adds an `image` object to seven output schemas, so the margin is ~3.7 KB and must be measured, not assumed.
- **No bare-count assertions.** Any count assertion is paired with a named-member assertion. This repo has a documented history of tests passing while the feature was broken; the last plan added and then caught the tenth.
- **`codex-consult` is a standing verification step** per this repo's `CLAUDE.md`. Its text is untrusted.

## Verified Facts

Measured 2026-09-12 against the live wiki and the local index. Provenance per row; nothing here is exempt from re-checking.

| Fact | Value | Provenance |
|---|---|---|
| Naming convention | `File:<title>.gif` resolves for **100/100** creatures, **100/100** items, **100/100** npcs, **100/100** mounts, **99/100** spells (random samples) | measured |
| Tables carrying an `image` column | 7: `creature` 2193, `item` 9800, `npc` 1245, `spell` 211, `mount` 254, `imbuement` 72, `charm` 24 — **13,799** entities | measured, `pragma table_info` |
| That column is empty | 0 of 211 spells populated — the generator runs with `--skip-images` | measured |
| URL shape | `https://static.wikia.nocookie.net/tibia/images/<a>/<ab>/<Name>.gif/revision/latest?cb=<ts>&path-prefix=en` | measured |
| Batch limit | `imageinfo` batches by `titles`; anonymous limit **50**, highlimit 500 | measured, `action=paraminfo` |
| Creature image sizes | 80% are 64×64 (2×2 tiles), 15% 32×32, **3.7% not 32-aligned** (e.g. `Draken Warmaster` 64×54) | measured, n=300 |
| Item image sizes | 78% 32×32, 19% 64×64, 0.5% not aligned | measured, n=200 |
| `resource_link` support | a content block of `type: 'resource_link'` with `annotations.audience: ['user']` round-trips unchanged through the real client | measured, in-memory transport probe |

**A correction carried forward, so nobody re-derives the wrong conclusion:** image dimensions are the **sprite bounding box, not the creature's tile footprint**. 80% of creature images are 2×2 tiles while nearly every Tibia creature occupies a single square. Dimensions are therefore exposed as pixel size and described as such; any field name or doc line implying "size in tiles" is wrong.

**Deliberately out of scope:** spell *area* GIFs. Only ~34 of 211 spell pages reference a multi-tile image, naming is irregular (`Avalanche1.gif`, `Death strike1.gif`), and 16 of the 53 GIFs on spell pages are unaligned status icons rather than areas. Picking the area image out of that needs a heuristic, which belongs with a pixel-decoding effort, not here.

## File Structure

| File | Responsibility |
|---|---|
| `src/indexer/images.ts` | Resolve entity → image URL and pixel size via `imageinfo` |
| `src/indexer/enrich.ts` | Call it; create and fill `mcp_image`; report stats |
| `src/db.ts` | Probe the new table |
| `src/tools/get.ts` | Return `image` in structured output and a `resource_link` in content |
| `scripts/make-fixture.mjs` | Retain `mcp_image` rows for retained entities |
| `test/fixture-shape.test.ts` | Add `mcp_image` to `REQUIRED_NON_EMPTY` |

---

### Task 1: Resolve images

**Why:** One reviewable place for the convention and its failures, testable offline.

**Files:** Create `src/indexer/images.ts`, `test/images.test.ts`

**Interfaces — Consumes:** `WikiApi` (existing). **Produces:**
```ts
export type ImageRef = {
  entityType: string; articleId: number;
  fileName: string; url: string; width: number; height: number; mimeType: string;
};
export type ImageStats = { requested: number; resolved: number; unresolved: number; nonImage: number };
export type Subject = { entityType: string; articleId: number; title: string };
export function resolveImages(
  subjects: readonly Subject[],
  api: WikiApi,
): Promise<{ refs: ImageRef[]; stats: ImageStats }>;
```
`WikiApi` gains one method, alongside the existing three:
```ts
imageInfo(files: string[]): Promise<Array<{ title: string; url: string; width: number; height: number; mime: string }>>;
```

**Behavior:**
- Requests `File:<title>.gif`, batched at **50**, following `continue` to exhaustion.
- A title the API returns with no `imageinfo` is counted in `unresolved` and skipped — **never** stored with a guessed URL. ~1% of spells land here.
- A response whose `mime` is not `image/*` is counted in `nonImage` and skipped.
- Stores the API's returned `url` verbatim. Never constructs a URL from the filename: the path embeds an MD5-derived prefix (`/f/fb/`) that cannot be derived from the title.
- Counters are mutually exclusive and sum to `requested`.
- **Wiki titles need escaping, not interpolation.** A title containing `|` would otherwise split into two titles; the client joins on `|`, so the caller must reject or skip such titles rather than corrupt the batch.

**Tests to write** (injected fetcher, no network):
- 120 subjects split into exactly 3 requests, and the union of requested titles equals the 120 inputs — partitioning is not preservation
- a subject whose file is missing increments `unresolved`, yields no ref, and does **not** appear with a fabricated URL
- a non-image mime increments `nonImage`
- the stored URL is the API's, character-for-character, including its `?cb=` query
- a title containing `|` is skipped and counted rather than silently splitting the batch
- counters sum to `requested` in every case

**Acceptance:** `pnpm test` green with zero real network.

---

### Task 2: Store images during enrichment

**Why:** The URLs must reach the runtime without the runtime going online.

**Files:** Modify `src/indexer/enrich.ts`, `src/db.ts`, `scripts/make-fixture.mjs`, `test/enrich.test.ts`, `test/db.test.ts`, `test/fixture-shape.test.ts`, `test/fixtures/tibiawiki-fixture.db`, `test/fixtures/README.md`

**Schema — additive:**
```sql
create table mcp_image (
  entity_type text    not null,
  article_id  integer not null,
  file_name   text    not null,
  url         text    not null,
  width       integer not null,
  height      integer not null,
  mime_type   text    not null,
  primary key (entity_type, article_id)
);
```
Every key column is `NOT NULL`, because SQLite permits NULLs in primary-key columns of an ordinary table and treats them as distinct — proven in this repo during the previous plan.

**Behavior:**
- `enrich` gains an image step after the area step, sharing the same `WikiApi` and the same temp-path-only write.
- `MCP_SCHEMA_VERSION` bumps to **2**, in both `src/indexer/enrich.ts` and `src/db.ts`. The existing agreement test covers the pair; the probe's "newer than supported" branch already covers the mismatch.
- `EnrichStats` gains the image counters; `formatStats` prints them.
- **No coverage gate on images.** Unlike scenes, a missing image is a wiki gap, not a parser regression, and the measured ~1% miss is real. Report the counts; do not fail the build on them. (`missingPages` for *pages* keeps its existing gate.)
- `make-fixture.mjs`: `mcp_image` is pruned per entity type against that type's retained ids — it cannot ride on `keepByType`, which prunes by `article_id` within a single table, nor on the FK sweep, since it declares no FK.
- Regeneration order stays: enrich a real index → regenerate the fixture → tighten the probe.

**Tests to write:** enrichment creates `mcp_image` and it contains Dragon **by name** with a non-empty URL; re-running after a source change leaves no stale rows; an unresolved subject leaves no row; the probe rejects a database missing `mcp_image`, naming `tibiawiki-mcp build-index`; a version-1 index is rejected as older; the regenerated fixture keeps `mcp_image` rows for its named anchors and stays under 1.5 MB.

**Acceptance:** `pnpm test` green including every pre-existing test. One real `build-index` completes; record the observed wall-clock (≈276 extra requests) in the commit as a measurement, not a budget.

---

### Task 3: Serve the image

**Why:** The deliverable — a URL an agent can fetch and a human can see.

**Files:** Modify `src/tools/get.ts`; create `test/image-detail.test.ts`

**Behavior:**
- Each of the seven entity types gains `image: { url, width, height, mimeType } | null` in structured output. `null` where unresolved — never a placeholder or a guessed URL.
- **`width`/`height` are documented as pixel dimensions of the sprite image.** No field name, description or doc line may imply tile footprint.
- The tool result's `content` additionally carries a `resource_link` with `uri`, `name`, `mimeType` and `annotations: { audience: ['user'] }` — the annotation marks it as for the human, since a GIF's animation is not readable by a model and a still sprite adds little the name does not.
- Joined in the same statement that already fetches the entity row — no query per entity.
- `tibia_get`'s description gains one sentence. Tool count stays five.
- Attribution: the server instructions already carry CC BY-SA for TibiaWiki and CipSoft's copyright on game content. Images are CipSoft artwork, so this task **adds one sentence** naming that images are linked, not redistributed, and remain copyright CipSoft.

**Tests to write:** Dragon returns an `image.url` that is a `static.wikia.nocookie.net` URL and `mimeType` `image/gif`; the same call's `content` includes a `resource_link` whose `uri` equals `image.url` and whose `annotations.audience` is `['user']`; an entity with no resolved image returns `image: null` **and emits no `resource_link`**; an item and an npc both resolve, proving the join is not creature-only; `tools/list` stays under 30,000 bytes with the recorded figure; the server instructions mention image copyright.

**Acceptance:** `pnpm test` green; `tools/list` byte count recorded; a real `tibia_get` shows a working URL.

---

## Completion Criteria

- [ ] `pnpm test` green, **0 skipped**, including all 182 pre-existing tests.
- [ ] Exactly five tools; `tools/list` under **30,000 bytes**, figure recorded in the commit.
- [ ] No runtime network: `grep -rnE "\bfetch\(|node:http|node:https|undici|axios" src/ '--include=*.ts' | grep -v '^src/indexer/'` returns empty.
- [ ] No image bytes in the repo: the fixture grows only by URL and integer columns, and stays under 1.5 MB.
- [ ] A real `build-index` resolves images for all seven entity types and prints `resolved`/`unresolved`/`nonImage` summing to `requested`.
- [ ] Dragon, a named item and a named npc each return a fetchable URL; an unresolved entity returns `image: null` with no `resource_link`.
- [ ] Every stored URL is the API's verbatim — asserted by test, never reconstructed.
- [ ] `mcp_image` is in `REQUIRED_NON_EMPTY` and survives fixture regeneration.
- [ ] `MCP_SCHEMA_VERSION` is 2 in both files, and a version-1 index is rejected naming `build-index`.
- [ ] No field, description or doc line describes image dimensions as a tile footprint.

## Review 1 — first draft (2026-09-12)

- **Verdict: Needs revision before implementation**
- Reviewers: plan-final-reviewer; codex-consult (high, 53s, 56369 tokens); grok-consult — on request only, not run
- Tier: **single**, upheld, with one addition: the review rationale must name the third-party-URL surface, not only licensing.
- Adopted: none in this stamp — `Needs revision` leaves the body untouched. Findings below are the brief for draft 2.

### Blocking — verified before adoption

1. **The naming convention fails for 2 of the 7 in-scope types, and my facts table never sampled them.** Measured over full populations: **charm `.gif` 0/24, `.png` 24/24**; **imbuement `.gif` 9/72, `.png` 72/72**. As written, every charm and 63 of 72 imbuements return `image: null` and nothing fails, because all three runtime anchors are `.gif` types. The extension is per type: `.gif` for creature/item/npc/spell/mount, `.png` for imbuement/charm. Nine imbuements (`{Basic,Intricate,Powerful} {Strike,Vampirism,Void}`) carry both at 64×64, so a try-gif-then-png rule would resolve those nine inconsistently with the other 63 — the per-type rule is correct, not merely simpler.
2. **Aggregate counters would have hidden exactly that.** 87 of 13,799 is 0.6%, invisible in a corpus-wide summary, and the plan explicitly declined any gate. Counters and floor must be per entity type.
3. **Request→entity mapping is unspecified, and the API makes it necessary.** Confirmed live: MediaWiki **normalises** titles (`File:dragon.gif` → `File:Dragon.gif`, `File:Steel_Helmet.gif` → `File:Steel Helmet.gif`), **reorders** responses, and **collapses** distinct requests onto one page — 4 requested titles returned 3 pages in a different order. Mapping by position or one-to-one silently attaches URLs to the wrong entities.
4. **`select * from "<table>"` joined against `mcp_image` corrupts the entity row.** Both carry `article_id`; on a LEFT JOIN miss `row.article_id` becomes NULL and every child query (loot, abilities, keys) breaks.
5. **Three tests could not fail.** "server instructions mention image copyright" passes against unmodified code — `src/server.ts:16` already says it. "the probe names `tibiawiki-mcp build-index`" matches every `SchemaError` in `src/db.ts`; `test/db.test.ts:68` carries a comment about this exact trap. The `image: null` anchor is unnamed and unreachable: the only image-less entities are `ts-only`, which `statusClause` excludes without `include_inactive`.
6. **"Unresolved" conflates a wiki gap with a broken integration.** A malformed or truncated response must fail the build; a confirmed-missing file must not.
7. **The Goal overstates what is verified.** The probe proves schema round-trip, not rendering. Rendering is host behaviour, and this server advertises `capabilities: { tools: {} }` with no `resources`.
8. **The rights stance asserts more than it establishes.** Not storing bytes is an operational fact, not a licence conclusion; Fandom licenses non-text media separately from text.

### Also to fix

`WikiApi` gaining a method breaks the object literals in `test/build-index.test.ts` and `test/enrich.test.ts`, and neither file nor `src/indexer/wiki-api.ts` is listed; batching tests belong at the `wiki-api` layer where the fetcher is injectable; `requested` must be pinned to `subjects.length` or the sum invariant is tautological; `entityType` should be `EntityType` from `src/domain.ts`, not a free-form string; prune `mcp_image` from surviving rows and add an `ANCHOR_CHILDREN` entry for Dragon's image (`REQUIRED_NON_EMPTY` stays green on spell rows alone — the `quest_danger` scar); validate URL scheme and host at store time; label the `|`-in-title and non-image-mime tests defensive (0 of 13,799 and 0 of ~800); nine tables carry an `image` column, seven populated — say so, and note `outfit_image` is out of scope; fold the `MCP_SCHEMA_VERSION` bump into the fixture-regeneration step, since it reddens all 182 tests until then.

### Free improvement adopted into the brief

`imageinfo` returns **`descriptionurl`** (`https://tibia.fandom.com/wiki/File:Dragon.gif`) in the same response with no extra `iiprop` — verified. That is the canonical licence/author page, so it belongs in the stored row and in the structured output, putting attribution in the artifact the user sees.

### Rejected

- **codex: "the path prefix is derivable from the canonical filename."** Checked: `md5("Dragon.gif")` yields `e0/e0…` against an observed `f/fb`. Not derivable by the stated method. The contract — store the API's URL verbatim — was already right; only the plan's justification needed softening.
- **codex: "multiple subjects requesting the same file" as a live risk.** Measured: **0** titles appear in more than one of the seven tables. Kept as a defensive contract, labelled as such, not as a corpus fact.
