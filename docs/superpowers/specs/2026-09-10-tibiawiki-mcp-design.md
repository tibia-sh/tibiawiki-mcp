# TibiaWiki MCP Server — Design

**Date:** 2026-09-10
**Status:** Approved for planning
**Review tier:** single (`reviewer`) — read-only local server; no auth, secrets, concurrency, or data-loss surface.

## 1. Problem

Every useful question about Tibia is an *attribute query*:

- "Which creatures are weak to fire and give over 500 experience?"
- "What drops a Dragon Shield, and how likely is it?"
- "Where do I buy a Steel Helmet, and for how much?"

No upstream source can answer these. This was verified against live endpoints on 2026-09-10:

| Source | Attribute query | Evidence |
|---|---|---|
| Fandom `api.php` | No | No Cargo (`action=cargoquery` → `badvalue`), no Semantic MediaWiki. Structured data exists only inside Infobox wikitext. |
| Fandom `list=search` | No | No CirrusSearch. `fire resistant dragon` returns *Dragon Necklace*, *Dragon Robe*. No `totalhits`, empty snippets. |
| tibiawiki.dev | No | OpenAPI spec has 55 paths and exactly one query parameter: `expand`. Lookup is by exact page title only. |

The wiki is a document store with no query layer. Answering these questions requires an index.

## 2. Key finding: an index is cheap

Measured, not estimated:

- Full wiki mirror via `api.php`: ~486 requests, ~5.3 min, ~60 MiB wikitext.
- `tibiawiki-sql` full generation (`--skip-images`): **3 min 13 s, 14 MB, exit 0**.
- Resulting corpus: 2,193 creatures · 9,800 items · 1,245 NPCs · 370 quests · 211 spells · 571 achievements · 1,090 houses · 19,496 creature drops · 13,964 NPC offers · 23,292 item attributes.
- Attribute query latency against that file: **~15 ms**.

Because the index is this cheap, it becomes the backbone rather than an optimization.

## 3. Architecture

Three components with one direction of data flow, and no shared state.

```
 [ build time, periodic ]              [ artifact ]           [ runtime ]

  tibiawiki-sql 9.0.0        ──▶   tibiawiki.db        ──▶   MCP server (stdio)
  (Docker or uvx, pinned)          SQLite, ~14 MB            @modelcontextprotocol/server 2.0.0
  --skip-images                    read-only at runtime      node:sqlite, read-only
```

**The runtime never contacts Fandom.** That is the central property. It sidesteps, in one move: undocumented rate limits, the crawler/robots policy question, Cloudflare edge behaviour, broken upstream search, and the absence of a structured backend. All network access is confined to a deliberate, periodic, offline build step.

### 3.1 Indexer (build-time)

A thin command, `tibiawiki-mcp build-index`, that runs the pinned upstream generator and places the result in a cache directory.

- Runs `uvx --from tibiawikisql==9.0.0` — the invocation verified end-to-end on 2026-09-10 (3m13s, 14 MB, exit 0). The published Docker image `galarzaa90/tibiawiki-sql:9.0.0` exists but its entrypoint was not verified, so Docker support is deferred rather than guessed at.
- Always `--skip-images`. Images are CipSoft IP and buy nothing for text queries; excluding them removes the highest-risk artifact entirely.
- Output path resolution, in order — one rule, used identically by the indexer and the server:
  1. `$TIBIAWIKI_MCP_DB` if set (used for development against a full local DB).
  2. `${XDG_CACHE_HOME:-~/.cache}/tibiawiki-mcp/tibiawiki.db` otherwise.
- Writes to a temp path and renames on success, so a failed rebuild never leaves a partial DB in place.

We adopt Galarzaa90's schema rather than writing a parser. Rationale in §7.

### 3.2 Server (runtime)

- `@modelcontextprotocol/server@2.0.0` + Zod 4, ESM, Node ≥20.
- SQLite via **`node:sqlite`** (`DatabaseSync`, `readOnly: true`) — in the Node standard library, so the only runtime dependency is the MCP SDK itself.
- Single `createServer()` factory. Bound to `serveStdio` for local use; the same factory is what tests drive and what `createMcpHandler` would take if hosting is ever wanted. No shared mutable state, matching a protocol that no longer has sessions.
- Statements prepared once per process and reused.

### 3.3 Startup invariants — fail fast

The server validates before serving, and exits with an actionable message rather than degrading:

1. DB file exists and opens read-only. If missing → tell the user to run `build-index`.
2. Required tables and columns are present (schema probe). If the upstream schema has shifted → name the missing column, do not silently return nulls.
3. Read `database_info` for `version` and `generate_time`. Surface both in `server/discover` output and in tool responses, so staleness is visible to the model instead of implicit.

## 4. Tool contracts

Five tools, shaped around questions rather than mirroring tables. All carry `annotations: { readOnlyHint: true }`, an `outputSchema` with `structuredContent`, and `ttlMs`/`cacheScope` on list results as required by spec `2026-07-28`.

| Tool | Answers | Key inputs |
|---|---|---|
| `tibia_search` | "Is there a thing called roughly *X*?" | `query`, `types[]?`, `limit?`, `cursor?` |
| `tibia_get` | "Tell me everything about *X*." | `name`, `type?`, `verbosity?` |
| `tibia_find_creatures` | "Which creatures match these stats?" | `weak_to[]?`, `resistant_to[]?`, `experience_min/max?`, `hitpoints_min/max?`, `bestiary_class?`, `bestiary_level?`, `is_boss?`, `location_contains?`, `sort?`, `limit?`, `cursor?` |
| `tibia_find_items` | "Which items match these stats?" | `item_class?`, `weapon_type?`, `slot?`, `vocation?`, `required_level_max?`, `attack_min?`, `defense_min?`, `armor_min?`, `sort?`, `limit?`, `cursor?` |
| `tibia_how_to_obtain` | "Where do I get *X*?" | `item_name` |

`tibia_how_to_obtain` is a deliberate consolidation: it unions creature drops (with chance and quantity range), NPC sale offers (with price and city), and quest rewards, because "where do I get this" is one user question that spans three tables.

Elemental filters take names (`fire`, `ice`, `earth`, `energy`, `death`, `holy`, `physical`, `drown`, `lifedrain`) and map to `modifier_*` columns. `weak_to` means modifier > 100; `resistant_to` means modifier < 100. Encoding that rule once, server-side, keeps the model from having to know the convention.

### 4.1 Response discipline

- `verbosity: "concise" | "detailed"`, default `concise`. Concise omits long prose (`history`, `notes`, `bestiary_text`).
- All list tools paginate with an opaque cursor; hard cap on `limit`.
- Every response carries a `source` block: page title, canonical wiki URL, and the index `generate_time`.
- Errors that the model can act on (name not found, ambiguous name) return `isError: true` with actionable text and suggestions — not JSON-RPC errors. JSON-RPC errors are reserved for malformed calls.

### 4.2 Attribution

Wiki content is CC-BY-SA; the underlying game content is CipSoft's. Both obligations are met in the response itself, not in a README nobody reads: each response's `source` block links the specific wiki page, and server metadata carries the CC-BY-SA credit to TibiaWiki and its contributors plus the CipSoft copyright notice.

## 5. Testing

- **Fixture DB**, committed at `test/fixtures/tibiawiki-fixture.db` (outside the gitignored `data/`): a trimmed copy of the real database — a few hundred rows spanning every table the tools touch — built by a checked-in script from a full generation, so it is reproducible rather than a mystery binary. Tests are deterministic and never touch the network. Its `README` carries the CC-BY-SA attribution, since it is redistributed wiki content.
- **Unit**: filter/SQL construction, elemental modifier mapping, cursor encode/decode, row→output shaping, verbosity trimming.
- **Integration**: a real `Client` driven against `handler.fetch` in-process — no subprocess, no port. Covers tool listing, each tool's happy path, pagination across a boundary, and the not-found/ambiguous paths.
- **Startup invariants**: missing DB, missing column, and unreadable file each produce the specific expected error.
- **Smoke in CI**: `npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list`.

Known-answer cases drawn from verified data, so a silent regression in the pipeline is caught:
`Dragon` → hp 1000, exp 700, `modifier_fire` 0 · `Dragonbone Staff` drop chance ≈ 0.0557% from `Dragon` · `Magic Longsword` → zero droppers (correct: not obtainable from any monster or quest).

## 6. Verification

| Claim | Command |
|---|---|
| Builds and typechecks | `npm run build` |
| Tests pass | `npm test` |
| Server starts and lists tools | `npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list` |
| A real attribute query returns | `... --method tools/call --tool-name tibia_find_creatures --tool-arg weak_to=fire` |
| Index reproducible | `tibiawiki-mcp build-index` exits 0 and `database_info.version` = `9.0.0` |

## 7. Decisions and rationale

**Adopt tibiawiki-sql's schema instead of writing a parser.** It is Apache-2.0, actively maintained (v9.0.0, 2026-07-22), and its output is better than a first-pass parser would be: typed columns on `creature` (`hitpoints INTEGER`, `mitigation REAL`) — though item stats are key/value TEXT rows in `item_attribute`, so numeric item filters need casts — relational join tables, and — decisively — **numeric drop chances** from Loot Statistics (`Dragonbone Staff` 0.0557%), where tibiawiki.dev exposes only the coarse string `"very rare"`. Writing our own parser now would be strictly worse work. If the schema ever constrains us, our own crawler remains the fallback; the measured cost of a full crawl (~5 min) is what keeps that option cheap.

**Snapshot, not live.** Chosen by the user. Game content changes on patch cycles, so hours-to-days staleness is immaterial, and it buys a runtime with no network, no rate limits, and millisecond queries.

**Skip images.** CipSoft IP, no value for text queries, and they dominate DB size.

**stdio only, but factory-structured.** Hosting is not a requirement. Structuring as a factory costs nothing today, is what the SDK wants anyway, and is what makes in-process testing possible.

## 8. Out of scope (v1)

Deliberately excluded, with the reason:

- **MCP resources / `resource_link`.** No host app is attaching documents yet. Revisit if payload size demands it.
- **Hosted HTTP transport.** Not a requirement; the factory keeps it cheap later.
- **Publishing a prebuilt DB.** Introduces CC-BY-SA redistribution questions and bandwidth for no benefit to a local user who can build in 3 minutes. Upstream notably does not publish one either.
- **Live fallback lookups.** Would reintroduce the network, the UA/robots question, and a second data path for the same facts. Only worth it if snapshot staleness proves painful in practice.
- **tibia.com live data** (characters, worlds, highscores). That is TibiaData's domain and a different product; conflating wiki knowledge with live server state would muddy every tool.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Upstream schema drift breaks queries | Startup schema probe names the missing column; pinned generator version; fixture tests catch shape changes |
| tibiawiki-sql abandoned | Apache-2.0 and forkable; our own crawler is a measured ~5 min fallback |
| Wiki template renames corrupt data upstream | Known-answer tests on stable entities detect it |
| Fandom blocks the build-time crawl | XML dump fallback verified live: `s3.amazonaws.com/wikia_xml_dumps/t/ti/tibiawiki_pages_current.xml.7z`, 71 MB, keyed by *wikiid* not subdomain |
| Index goes stale silently | `generate_time` surfaced in every response and in discovery |
