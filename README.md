# tibiawiki-mcp

An offline MCP server for TibiaWiki. It answers the questions the wiki itself cannot:

- *Which creatures are weak to fire and give over 500 experience?*
- *What drops a Dragon Shield, and how likely is it?*
- *Where do I buy a Steel Helmet, and for how much?*

**The server makes no network calls.** Every answer comes from a local SQLite snapshot
that installs with it, so queries return in milliseconds and work offline.

## Why it exists

TibiaWiki runs on Fandom without Cargo, Semantic MediaWiki or CirrusSearch, so there is
no way to query it by attribute — every structured value is trapped inside Infobox
wikitext, and the built-in search returns *Dragon Necklace* for `fire resistant dragon`.
The public REST API over the same wiki exposes exactly one query parameter. Building a
local index is the only way to ask a real question.

## Requirements

- **Node ≥ 22.13** to run it (`node:sqlite` landed in 22.5 and is unflagged from 22.13).
- **Node ≥ 22.18 to develop it** — the test suite runs TypeScript directly, and
  type-stripping is only on by default from 22.18. Consumers are unaffected: the
  published package ships compiled JavaScript.
- [`uv`](https://docs.astral.sh/uv/) only if you build your own index.

## Install

```bash
pnpm add -g @tibia.sh/tibiawiki-mcp
```

The index comes with it as
[`@tibia.sh/tibiawiki-data`](https://github.com/tibia-sh/tibiawiki-data), an 18 MB
dependency. You don't build anything first.

## Use with Claude Code

Two ways, and they ship different things.

**As an MCP server only**, from the npm package:

```bash
claude mcp add --transport stdio tibiawiki -- npx -y @tibia.sh/tibiawiki-mcp
```

**As a plugin**, the server *plus* a skill that teaches an agent how to query it: name
resolution, the 100-is-neutral modifier convention and the data quirks that produce wrong
answers. The plugin pieces never reach the npm tarball, because `package.json` has
`files: ["dist", "data/spell-areas.json", "data/tibiawikisql-requirements.txt"]`.

This repository is also the plugin's marketplace. Add it, then install the plugin:

```bash
claude plugin marketplace add tibia-sh/tibiawiki-mcp
claude plugin install tibiawiki-mcp@tibiawiki-mcp
```

In a session, `/plugin marketplace add tibia-sh/tibiawiki-mcp` and
`/plugin install tibiawiki-mcp@tibiawiki-mcp` do the same, and `/plugin install` asks which
scope you want. From the shell, the plugin installs at user scope by default, so it loads in
every project.

The plugin runs the published package through `npx`, at the exact version it was released
with. It needs no `pnpm install` and no build. The first start downloads the package, and
later starts work offline.

Updates arrive with releases. Auto-update is off by default for third-party marketplaces, so
you update the plugin yourself:

```bash
claude plugin update tibiawiki-mcp@tibiawiki-mcp
```

A `tibiawiki` server you added earlier with `claude mcp add` runs beside the plugin's server
when its command differs from the plugin's, as the npm package command above does. Remove it
with `claude mcp remove tibiawiki -s <scope>`. For a server in `local` scope, the default, run
that from the project you added it in.

In a checkout, `claude --plugin-dir .` loads the plugin for one session. It still runs the
published package at the pinned version, not your local source.

## What the skill adds

The MCP server alone gives an agent the tools. The bundled skill gives it the
judgement to use them well — and it costs one line of context until it fires:

- resolve approximate names with `tibia_search` before `tibia_get`
- modifiers are percentages where 100 is neutral, so a Dragon at `modifier_fire: 0`
  is *immune* to fire, not weak to it
- `hitpoints: null` means unrecorded, not zero — 433 creatures have no recorded health
- `imbuement.slots` is a category list, not a count
- non-active pages are hidden unless `include_inactive: true`

## Tools

| Tool | Answers |
|---|---|
| `tibia_search` | "Is there a page called roughly X?" |
| `tibia_get` | "Tell me everything about X." — creature, item, NPC, quest or spell |
| `tibia_find_creatures` | "Which creatures match these stats?" |
| `tibia_find_items` | "Which items match these stats?" |
| `tibia_how_to_obtain` | "Where do I get X?" — drops, vendors and quest rewards in one call |

Damage modifiers are percentages where **100 is neutral**: above 100 the creature takes
extra damage from that element. `weak_to` and `resistant_to` encode that for you.

Deprecated, event-only and unavailable pages are excluded by default; pass
`include_inactive: true` to see them.

## Refreshing

A fresh install resolves the newest data release this server can read. An existing
install keeps its release until you update it. For data fresher than the last release,
build your own index:

```bash
tibiawiki-mcp build-index      # about 6 minutes
```

It writes to `$TIBIAWIKI_MCP_DB` if you set it, and to
`${XDG_CACHE_HOME:-~/.cache}/tibiawiki-mcp/tibiawiki.db` otherwise. A failed build
never replaces a working index, because the new one is validated before it is
installed. Every answer reports `indexGeneratedAt`, so staleness is always visible to
whoever is asking.

The build runs the generator from a throwaway environment that uv creates in your temp
directory. `uv pip install --require-hashes` installs it from
`data/tibiawikisql-requirements.txt`, which pins the generator and every dependency to an
exact version, with a hash for every file uv may download. A download that does not
match its hash stops the build before the generator runs. The environment is deleted as
soon as the generator exits, or as soon as a step before it fails. uv still reads your
own settings, such as `UV_CACHE_DIR` and `UV_EXCLUDE_NEWER`.

The environment runs CPython 3.10 to 3.13. uv uses one you have installed, or downloads
one. The range stops before 3.14 because `mwparserfromhell` 0.7.2, the newest release of
one of the generator's dependencies, ships no wheels for 3.14, and the build never
compiles a dependency from source.

The server reads the first index it finds:

1. `$TIBIAWIKI_MCP_DB` => an explicit path always wins
2. `${XDG_CACHE_HOME:-~/.cache}/tibiawiki-mcp/tibiawiki.db` => an index you built
3. `@tibia.sh/tibiawiki-data` => the data release installed with the server

A built index keeps winning over every later data release. If the server cannot read
it, you get an error, not a fallback. Delete it to go back to the packaged one.

`tibiawiki-mcp index-digest <path>` prints a SHA-256 over the rows and columns the tools
read from an index. Two indexes with the same digest hold the same rows, in any stored
order. Build stamps such as `indexGeneratedAt` are left out. The data repo's drift job
will use it to tell new wiki content from a rebuild of the same content.

### Checking for upstream drift

Spell area shapes are decoded once and committed to `data/spell-areas.json`. To find
out whether TibiaWiki has re-uploaded any of the source animations since:

```bash
pnpm decode-spell-areas <path-to-index.db> --check
```

It fetches metadata only, prints any image whose revision moved (and any new
candidate the file has never seen), and exits non-zero if there is drift — so it can
run on a schedule. Re-run without `--check` to regenerate.

### Refreshing the generator lock

To move `data/tibiawikisql-requirements.txt` to newer releases, run:

```bash
pnpm lock-generator
```

It resolves the generator and its dependencies afresh with the `uv` on your `PATH`, using
only files uploaded at least 7 days before the run. The old lock plays no part, so its
pins cannot hold back the new resolution. Before it writes the new lock, it runs a dry-run
install without a build for every CPython the range admits, on every platform the header
lists, and it refuses to write a lock that fails any of them.

The range is `GENERATOR_PYTHON` in `src/indexer/build-index.ts`. To raise the cap once
every dependency ships wheels for a newer Python, raise the constant and run
`pnpm lock-generator`, which checks the new version too. Until the lock is regenerated,
`pnpm test` fails on its header.

The lock's header records the cutoff, the uv version, the Python range, the platforms
checked and the command. To reproduce a lock, put the uv version named in its header
first on your `PATH`, and pass the header's cutoff. Leave out any uv setting of your own
that changes how uv resolves, such as a `uv.toml` or `UV_INDEX_URL`, because the header
cannot record it:

```bash
pnpm lock-generator --cutoff <cutoff>
```

## Releases

Releases go to npm as `@tibia.sh/tibiawiki-mcp`, starting at `0.1.0`.
[docs/RELEASING.md](docs/RELEASING.md) covers how a release is published and what to do
when one fails.

The version number describes the server, not the data. The index ships separately as
[`@tibia.sh/tibiawiki-data`](https://github.com/tibia-sh/tibiawiki-data), and its major
version is the index schema version. The server depends on `^3`, the schema it reads.
`test/data-package.test.ts` keeps that range in step with `MCP_SCHEMA_VERSION`, so npm
refuses to install an index the server cannot read.

The caret is a deliberate exception to this repository's exact pins. An exact `3.0.0`
would keep major 4 out just as well, so the caret is not what guards the schema. It lets
an install, a hosted instance included, pick up each compatible data release without a
server release. `pnpm add` does not write `^3`, so edit the range by hand.

The tarball ships exactly `dist/`, `data/spell-areas.json` and
`data/tibiawikisql-requirements.txt`, plus the `package.json`,
`README.md` and `LICENSE` npm always adds; `test/packaging.test.ts` runs
`npm pack --dry-run` as part of `pnpm test`, so anything else leaking in fails CI.

`pnpm smoke <tarball-or-package@version>` is the consumer-side check: it installs the
package into a throwaway directory and drives the *installed* binary over real stdio —
against a local tarball before publishing, against the registry after.

## Attribution

Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by
CipSoft; game content and images are copyright CipSoft GmbH.

The index is generated by [tibiawiki-sql](https://github.com/Galarzaa90/tibiawiki-sql)
(Apache-2.0). Images are deliberately never fetched or stored.

This project's own code is MIT licensed; see `LICENSE`. That covers the code only — the
data it serves is CC BY-SA and not ours to relicense.
