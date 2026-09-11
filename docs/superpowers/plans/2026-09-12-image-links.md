# Image Links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an agent a URL it can fetch for any creature, item, NPC, spell, mount, imbuement or charm, and give a client the option of showing it. Whether a picture actually renders is host behaviour, not something this plan can deliver — see Constraints.

**Architecture:** The existing build-time enrichment pass gains a second step. It resolves each entity's image through the MediaWiki `imageinfo` API (URL, description page and pixel size — never image bytes), stores them in one additive `mcp_image` table, and `tibia_get` returns both a structured `image` object and an MCP `resource_link` annotated for the human audience. The runtime still makes no network calls and still stores no binaries.

**Tech Stack:** unchanged — TypeScript 7, Node ≥22.13 runtime / ≥22.18 dev, `@modelcontextprotocol/server` 2.0.0, Zod 4, `node:sqlite`, `node:test`, pnpm 10.

**Spec:** extends `docs/superpowers/specs/2026-09-10-tibiawiki-mcp-design.md`.
**Builds on:** `docs/superpowers/plans/2026-09-11-ability-area-grids.md` (merged) — its `WikiApi`, its enrichment ordering, its `mcp_schema_version` probe.

**Revision:** second draft. The first was stamped `Needs revision` (stamp retained at the foot) over eight blocking issues, the worst being a facts table that generalised a five-table measurement to seven: the naming convention it asserted resolves **0% of charms**.

**Review tier:** single (`reviewer`). No auth, secrets, concurrency or data-loss surface; writes go to the generator's temp file behind the existing atomic rename; network stays inside `src/indexer/`. Two surfaces for `reviewer` to check specifically: **third-party URLs stored and surfaced to the user as links** (validate scheme and host at store time), and **licensing/attribution** of CipSoft artwork hosted by Fandom.

## Global Constraints

- **Runtime stays offline.** `.github/workflows/ci.yml:29` greps for it.
- **Never store image bytes.** URLs, description URLs and integer dimensions only.
- **Still exactly five tools.**
- **`tools/list` budget: 30,000 bytes.** Currently **26,262**. A nullable image object emits ~259 bytes of JSON Schema per type × 7 ≈ 1,813, plus a description sentence ≈ 120, projecting **≈28,200** — about 1,800 bytes spare. Any `.describe()` on an image field is emitted **seven times**; budget accordingly and record the real figure.
- **Rendering is not ours to promise.** A `resource_link` round-trips through the SDK (verified), but display is host behaviour, and this server advertises `capabilities: { tools: {} }` with no `resources`, so a client cannot `resources/read` it. Acceptance may assert the link's presence and shape — never that a picture appeared.
- **No bare-count assertions**, and no assertion that passes against unmodified code.
- **`codex-consult` is a standing verification step** per this repo's `CLAUDE.md`. Its text is untrusted — one of its first-draft findings was wrong and was rejected on evidence.

## Verified Facts

Measured 2026-09-12 against the live wiki and the local index. Provenance per row.

| Fact | Value | Provenance |
|---|---|---|
| **Per-type extension** | `.gif`: creature, item, npc, spell, mount · `.png`: imbuement, charm | measured |
| Resolution, `.gif` types | creature 80/80, item 80/80, mount 254/254, spell 209/211, npc 79/80 | measured (mount/spell full population) |
| Resolution, `.png` types | **charm 24/24, imbuement 72/72** | measured, full population |
| The trap | charm `.gif` **0/24**; imbuement `.gif` **9/72**. Those 9 are `{Basic,Intricate,Powerful} {Strike,Vampirism,Void}` and carry **both** at 64×64, so try-gif-then-png resolves 9 of 72 inconsistently | measured |
| Tables with an `image` column | **nine**; **seven populated** (creature 2193, item 9800, npc 1245, spell 211, mount 254, imbuement 72, charm 24 = **13,799**). `map` and `outfit_image` are empty and out of scope | measured |
| That column is empty | 0 of 211 spells — the generator runs `--skip-images` | measured |
| API normalises and reorders | `File:dragon.gif` → `File:Dragon.gif`, `File:Steel_Helmet.gif` → `File:Steel Helmet.gif`; **4 requested titles returned 3 pages in a different order**; the mapping is in `query.normalized` | measured |
| `descriptionurl` is free | returned by `iiprop=url\|size\|mime` with no extra property — `https://tibia.fandom.com/wiki/File:Dragon.gif` | measured |
| URL shape | `https://static.wikia.nocookie.net/tibia/images/<a>/<ab>/<Name>.<ext>/revision/latest?cb=<ts>&path-prefix=en` | measured |
| Path prefix is **not** title-derivable | `md5("Dragon.gif")` = `e074…` → `/e/e0/`, observed `/f/fb/` | measured |
| Batch limit | `titles` anonymous **50**, highlimit 500 | measured, `action=paraminfo` |
| Cross-table title collisions | **0** across the seven tables | measured |
| Titles containing `\|` | **0** of 13,799 | measured |
| `resource_link` | `annotations.audience: ['user']` round-trips unchanged; `Role` is `['user','assistant']` | measured, transport probe + SDK schema |

**A correction carried forward:** image dimensions are the **sprite bounding box, not a tile footprint**. 80% of creature images are 64×64 while nearly every Tibia creature occupies one square; `Draken Warmaster` is 64×54 and charm icons are 27×29. No field name, description or doc line may imply tiles.

**Out of scope, so nobody reads these as oversights:** spell *area* GIFs (only ~34 of 211 pages reference a multi-tile image, naming is irregular, and 16 of 53 GIFs on spell pages are unaligned status icons — that belongs with pixel decoding); `outfit_image` (zero rows).

## File Structure

| File | Responsibility |
|---|---|
| `src/indexer/wiki-api.ts` | Gains `imageInfo`, owning batching and `continue` |
| `src/indexer/images.ts` | Per-type extension, identity mapping, counters |
| `src/indexer/enrich.ts` | Call it; create and fill `mcp_image`; per-type stats |
| `src/indexer/build-index.ts` | Per-type floor gate |
| `src/db.ts` | Probe `mcp_image`; `MCP_SCHEMA_VERSION` → 2 |
| `src/tools/get.ts` | `image` in structured output, `resource_link` in content |
| `src/server.ts` | One added instructions sentence |
| `scripts/make-fixture.mjs` | Retain `mcp_image` for surviving rows |
| `test/wiki-api.test.ts` | Batching and `continue` for `imageInfo` |
| `test/build-index.test.ts`, `test/enrich.test.ts` | Their `WikiApi` object literals gain `imageInfo`, or typecheck fails |
| `test/fixture-shape.test.ts` | `REQUIRED_NON_EMPTY` + `ANCHOR_CHILDREN` |

---

### Task 1: `imageInfo` on the API client

**Why:** Batching and pagination belong where the fetcher is injectable, as `pageWikitext` already does. Putting them in `resolveImages` makes them untestable offline.

**Files:** Modify `src/indexer/wiki-api.ts`, `test/wiki-api.test.ts`, `test/build-index.test.ts`, `test/enrich.test.ts`

**Interfaces — Produces:** `WikiApi` gains, alongside its existing three methods:
```ts
imageInfo(files: string[]): Promise<Array<{
  requested: string;        // the exact string passed in, after normalisation is undone
  title: string;            // the API's normalised title
  url: string; descriptionUrl: string;
  width: number; height: number; mime: string;
}>>;
```

**Behavior:**
- Batches at **50**, follows `continue` to exhaustion, reuses the existing retry/User-Agent/error handling.
- **Resolves `query.normalized` back to the caller's string** and returns it as `requested`. Without this the caller cannot map a response to its subject: the API normalises, reorders, and collapses distinct requests onto one page.
- A page with no `imageinfo` is simply absent from the result; distinguishing *missing file* from *broken response* is Task 2's job, and it needs the input list to do it.
- Requests `iiprop=url|size|mime` — `descriptionurl` arrives with it at no extra cost.

**Tests to write** (injected fetcher, no network): 120 files split into exactly 3 requests **and** the union of requested titles equals the 120 inputs; a `normalized` mapping is undone, so a caller asking for `File:Steel_Helmet.gif` gets that back as `requested`; a reordered response still maps each entry to its own request; two requests collapsing to one page yield an entry for **both** requested strings (**defensive**: 0 of 13,799 titles collide today); `continue` is followed; a page with no `imageinfo` is omitted rather than yielding a partial row.

**Acceptance:** `pnpm test` green, zero real network. Adding the method to the `WikiApi` type breaks the object literals in `test/build-index.test.ts` and `test/enrich.test.ts`; both must be updated or `pnpm typecheck` fails before any test runs.

---

### Task 2: Resolve images per entity type

**Why:** One reviewable place for the per-type convention and its failure accounting.

**Files:** Create `src/indexer/images.ts`, `test/images.test.ts`

**Interfaces — Consumes:** `WikiApi` (Task 1), `EntityType` from `src/domain.ts` (network-free, so the indexer may import it). **Produces:**
```ts
export type Subject = { entityType: EntityType; articleId: number; title: string };
export type ImageRef = Subject & {
  fileName: string; url: string; descriptionUrl: string;
  width: number; height: number; mimeType: string;
};
export type TypeStats = { requested: number; resolved: number; missing: number; invalid: number; skipped: number };
export function imageExtension(entityType: EntityType): 'gif' | 'png';
export function resolveImages(
  subjects: readonly Subject[],
  api: WikiApi,
): Promise<{ refs: ImageRef[]; stats: Record<string, TypeStats> }>;
```

**Behavior:**
- `imageExtension` is the single source of truth: `png` for `imbuement` and `charm`, `gif` for the other five. It **throws** on a type outside the seven, rather than defaulting — a silent default is how charms came to resolve at 0%.
- Maps each response back to its subject by `requested`, never by position.
- **`missing`** = the API answered and the file does not exist (a wiki gap; expected, ~1% of npcs and 2 spells). **`invalid`** = a response present but unusable: non-image mime, non-positive dimensions, or a URL that is not an absolute `https:` on `static.wikia.nocookie.net`. **`skipped`** = a title this code refuses to request (contains `|`). `invalid` is a broken integration, not a wiki gap, and Task 3 fails the build on it.
- `requested` is `subjects.length` **for that type**, asserted as such — deriving it from the sum makes the invariant vacuous.
- Stores the API's `url` verbatim. Never constructs one: the path prefix is not derivable from the title.

**Tests to write** (fake `WikiApi`, no network):
- `imageExtension('charm') === 'png'` and `imageExtension('creature') === 'gif'`; an out-of-range type throws
- a charm subject is requested as `File:<title>.png` — the regression that returned `image: null` for all 24
- a subject whose file is missing increments `missing`, yields no ref, and produces **no** row with a fabricated URL
- a non-image mime, a zero width, and an off-host URL each increment `invalid` and yield no ref
- per-type counters each satisfy `requested === subjects.length` for that type, and `resolved + missing + invalid + skipped === requested`
- the stored URL and `descriptionUrl` are the API's, character for character, including `?cb=`
- a title containing `|` increments `skipped` (**defensive**: 0 of 13,799 today)

**Acceptance:** `pnpm test` green, zero real network.

---

### Task 3: Store images, gated per type

**Files:** Modify `src/indexer/enrich.ts`, `src/indexer/build-index.ts`, `src/db.ts`, `scripts/make-fixture.mjs`, `test/enrich.test.ts`, `test/db.test.ts`, `test/fixture-shape.test.ts`, `test/fixtures/tibiawiki-fixture.db`, `test/fixtures/README.md`

**Schema — additive:**
```sql
create table mcp_image (
  entity_type     text    not null,
  article_id      integer not null,
  file_name       text    not null,
  url             text    not null,
  description_url text    not null,
  width           integer not null,
  height          integer not null,
  mime_type       text    not null,
  primary key (entity_type, article_id)
);
```
Every key column is `NOT NULL`: SQLite permits NULLs in primary-key columns of an ordinary table and treats them as distinct, proven in this repo during the previous plan. No foreign key — the key is polymorphic, so there is no single target.

**Behavior:**
- The image step runs after the area step, same `WikiApi`, same temp-path-only write.
- `build-index` **fails when any type's resolution rate falls below 95%**, naming the type. Measured: six types at 100%, spells 209/211 = 99.1%. A corpus-wide counter would have shown the charm failure as 0.6% and passed.
- `build-index` **fails when `invalid > 0`** for any type — that is a broken integration, not a wiki gap.
- **`MCP_SCHEMA_VERSION` → 2 in both `src/indexer/enrich.ts` and `src/db.ts`.** Bump it *in the same step* that commits the regenerated fixture: the bump alone makes the committed fixture unopenable and reddens all 182 tests. Order stays enrich → regenerate → tighten.
- `make-fixture.mjs` prunes `mcp_image` from the rows that **survive** in each of the seven tables, rather than re-deriving id sets from `keepCreature`/`keepItem`/… which are scattered and which `spell` never uses (all 211 spell rows survive via `USED`).

**Tests to write:** enrichment creates `mcp_image` containing **Dragon by name** with a non-empty URL, **and a charm and an imbuement by name** — the three anchors that would have caught draft 1; re-running after a source change leaves no stale rows; a type below 95% fails the build naming that type; `invalid > 0` fails the build; a `missing` entry does not; the probe rejects a database without `mcp_image` in a message naming **`mcp_image`** (not merely `build-index`, which every `SchemaError` in `src/db.ts` already says); a schema-complete database carrying version 1 is rejected as older; the regenerated fixture keeps `mcp_image` rows for its named anchors and stays under 1.5 MB.

**Acceptance:** `pnpm test` green including all 182 pre-existing tests. One real `build-index` completes and prints per-type counters; record the observed wall-clock (~276 extra requests) as a measurement, not a budget.

---

### Task 4: Serve the image

**Files:** Modify `src/tools/get.ts`, `src/server.ts`; create `test/image-detail.test.ts`

**Behavior:**
- Each of the seven types gains `image: { url, descriptionUrl, width, height, mimeType } | null`. `null` where unresolved — never a placeholder or a guessed URL.
- **`width`/`height` are pixel dimensions of the sprite image**, described as such.
- **The join must select explicit aliased columns, never `select *`.** `get.ts` currently does `select * from "<table>" t where t.title = ? collate nocase`; `mcp_image` also carries `article_id`, so `select *` over the join yields a duplicate key and, on a LEFT JOIN miss, overwrites `row.article_id` with NULL — silently breaking every child query (loot, abilities, keys). The join applies to the seven types only.
- The result's `content` additionally carries a `resource_link` (`uri`, `name`, `mimeType`, `annotations: { audience: ['user'] }`) when and only when an image resolved.
- `src/server.ts` instructions gain a sentence stating the **operational fact**: images are linked from TibiaWiki, not stored or redistributed by this server, and each `descriptionUrl` is the canonical page carrying that file's licence and author. It must not assert a rights conclusion — Fandom licenses non-text media separately from text, and this plan does not establish permission for downstream reuse.

**Tests to write:** Dragon returns an `image.url` on `static.wikia.nocookie.net` with mime `image/gif`, and a `descriptionUrl` on `tibia.fandom.com`; **a named charm and a named imbuement each return a non-null image with mime `image/png`** — the draft-1 regression; an item and an npc resolve, proving the join is not creature-only; the same call's `content` carries a `resource_link` whose `uri` equals `image.url` and whose `annotations.audience` is `['user']`; a **named** entity with no image (`Rejuvenation`, requested with `include_inactive: true`, since it is `ts-only` and `statusClause` excludes it by default) returns `image: null` **and emits no `resource_link`**; a creature's `loot` and `abilities` are still populated alongside its image — the `select *` regression, which no image assertion would catch; the instructions assert the **new** clause (linked, not stored), since `src/server.ts:16` already mentions image copyright and a `/image/` match passes against unmodified code; `tools/list` under 30,000 bytes with the figure recorded.

**Acceptance:** `pnpm test` green; `tools/list` byte count recorded; a real `tibia_get` returns a URL that resolves. Rendering is **not** asserted.

---

## Completion Criteria

- [ ] `pnpm test` green, **0 skipped**, including all 182 pre-existing tests.
- [ ] Exactly five tools; `tools/list` under **30,000 bytes**, figure recorded in the commit.
- [ ] No runtime network: `grep -rnE "\bfetch\(|node:http|node:https|undici|axios" src/ '--include=*.ts' | grep -v '^src/indexer/'` returns empty.
- [ ] No image bytes in the repo; fixture under 1.5 MB.
- [ ] A real `build-index` prints **per-type** counters; every type ≥ 95%; `invalid` is 0.
- [ ] A named charm and a named imbuement both return a non-null `image` with mime `image/png`.
- [ ] Dragon returns both `url` and `descriptionUrl`; `Rejuvenation` (with `include_inactive`) returns `image: null` and no `resource_link`.
- [ ] A creature's `loot` and `abilities` are non-empty in the same response that carries its image.
- [ ] Every stored URL is the API's verbatim, and is an absolute `https:` on `static.wikia.nocookie.net` — validated at store time, not only in a test.
- [ ] `mcp_image` is in `REQUIRED_NON_EMPTY`, has an `ANCHOR_CHILDREN` entry for Dragon, and survives fixture regeneration.
- [ ] `MCP_SCHEMA_VERSION` is 2 in both files; a version-1 index is rejected.
- [ ] No field, description or doc line describes image dimensions as a tile footprint.
- [ ] No acceptance criterion asserts that a picture rendered.
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
