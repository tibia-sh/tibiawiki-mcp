# Usage

The details behind the README: the Claude Code plugin, serving over HTTP, and building your own index.

## Install

You need **Node ≥ 22.13** to run it (`node:sqlite` landed in 22.5 and is unflagged from 22.13).

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
judgement to use them well, and it costs one line of context until it fires:

- resolve approximate names with `tibia_search` before `tibia_get`
- modifiers are percentages where 100 is neutral, so a Dragon at `modifier_fire: 0`
  is *immune* to fire, not weak to it
- `hitpoints: null` means unrecorded, not zero: 433 creatures have no recorded health
- `imbuement.slots` is a category list, not a count
- non-active pages are hidden unless `include_inactive: true`

## Serve over HTTP

To serve the tools over Streamable HTTP instead of stdio, run:

```bash
tibiawiki-mcp serve --http [--host <address>] [--port <number>]
```

It listens on `127.0.0.1:8080` unless you pass `--host` or `--port`. Point your client at
`http://<host>:<port>/mcp`. The endpoint is stateless and works with clients on protocol versions
`2025-11-25` and `2026-07-28`.

On a loopback address the server rejects a request to `/mcp` with a foreign `Host` or `Origin`
header. On any other address it skips those checks. Put your own edge in front of it to handle those
checks and TLS.

Request bodies are capped at 126 KiB and need a `Content-Length`. `GET /ping` answers `200`
for health checks.

On `SIGTERM` the server answers new requests with `503` and gives the ones in flight up to
10 s to finish. Ctrl-C does the same, and a second Ctrl-C stops it at once.

## Refreshing the index

Building your own index needs [`uv`](https://docs.astral.sh/uv/). Nothing else here does.

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
