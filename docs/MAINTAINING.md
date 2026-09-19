# Maintaining

What you need to work on the server. [RELEASING.md](RELEASING.md) covers publishing.

## Requirements

- **Node ≥ 22.13** to run it (`node:sqlite` landed in 22.5 and is unflagged from 22.13).
- **Node ≥ 22.18 to develop it**: the test suite runs TypeScript directly, and
  type-stripping is only on by default from 22.18. Consumers are unaffected: the
  published package ships compiled JavaScript.
- [`uv`](https://docs.astral.sh/uv/) only if you build your own index.

## Checking for upstream drift

Spell area shapes are decoded once and committed to `data/spell-areas.json`. To find
out whether TibiaWiki has re-uploaded any of the source animations since:

```bash
pnpm decode-spell-areas <path-to-index.db> --check
```

It fetches metadata only, prints any image whose revision moved (and any new
candidate the file has never seen), and exits non-zero if there is drift, so it can
run on a schedule. Re-run without `--check` to regenerate.

## Refreshing the generator lock

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
[RELEASING.md](RELEASING.md) covers how a release is published and what to do
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
package into a throwaway directory and drives the *installed* binary over real stdio and HTTP,
against a local tarball before publishing and against the registry after.
