# Maintaining

What you need to work on the server. [RELEASING.md](RELEASING.md) covers publishing.

## Requirements

- **Node ≥ 22.18 to develop it**: the test suite runs TypeScript directly, and
  type-stripping is only on by default from 22.18. Consumers are unaffected: the
  published package ships compiled JavaScript.

## Checking for upstream drift

Spell area shapes are decoded once and committed to `data/spell-areas.json`. To find
out whether TibiaWiki has re-uploaded any of the source animations since:

```bash
pnpm decode-spell-areas <path-to-index.db> --check
```

It fetches metadata only, prints any image whose revision moved (and any new
candidate the file has never seen), and exits non-zero if there is drift, so it can
run on a schedule. Re-run without `--check` to regenerate.

## The generator

`build-index` runs [tibiawiki-sql](https://github.com/tibia-sh/tibiawiki-sql), our copy of
[Galarzaa90/tibiawiki-sql](https://github.com/Galarzaa90/tibiawiki-sql), never the PyPI
release. The copy's release workflow builds a wheel for each release tag, attaches it
to the GitHub release and attests it. The server pins that wheel in
`src/indexer/build-index.ts`:

- `GENERATOR_VERSION` is the release's version, its tag without the `v`. The wheel's
  URL, `GENERATOR_WHEEL_URL`, is built from it.
- `GENERATOR_SHA256` is the sha256 of the approved wheel. It is the approval boundary.
  `pnpm test` fails on a lock that records any other wheel, so a release asset replaced
  after the fact cannot reach a build.

To move to a new release, set `GENERATOR_VERSION` and `GENERATOR_SHA256` to the new
wheel's, then run `pnpm lock-generator`, which needs `gh` signed in. The change goes
through a pull request like any other, because the new digest is a new approval.

`pnpm lock-generator` checks the attestation before it writes the lock. It downloads the
wheel, refuses it unless its sha256 is `GENERATOR_SHA256`, and runs
`gh attestation verify`, which must show that the copy's `release.yml` built it from the
tag `v<GENERATOR_VERSION>` on a GitHub-hosted runner. The check runs at lock time because
`build-index` installs by hash alone, on machines that may have no `gh`. The hash a
verified run writes into the lock carries that attestation to every build.

## Refreshing the generator lock

To move `data/tibiawikisql-requirements.txt` to newer dependency releases, run:

```bash
pnpm lock-generator
```

It resolves the generator and its dependencies afresh with the `uv` on your `PATH`. The
dependencies come from PyPI, and only files uploaded at least 7 days before the run count.
That cutoff does not apply to the generator, which is named by URL and has no upload time.
The generator is held by `GENERATOR_SHA256` instead. The old lock plays no part, so its
pins cannot hold back the new resolution. Before it writes the new lock, it checks the
generator as described above, checks that the lock records exactly that wheel with its
one hash, and runs a dry-run install without a build for every CPython the range admits,
on every platform the header lists. It refuses to write a lock that fails any of them.

The range is `GENERATOR_PYTHON` in `src/indexer/build-index.ts`. To raise the cap once
every dependency ships wheels for a newer Python, raise the constant and run
`pnpm lock-generator`, which checks the new version too. Until the lock is regenerated,
`pnpm test` fails on its header.

The lock's header records the cutoff, the uv version, the Python range, the platforms
checked, the wheel digest and tag the attestation was verified for (`attested`) and the
command. To reproduce a lock, put the uv version named in its header first on your
`PATH`, sign in to `gh`, and pass the header's cutoff. Leave out any uv setting of your
own that changes how uv resolves, such as a `uv.toml` or `UV_INDEX_URL`, because the
header cannot record it:

```bash
pnpm lock-generator --cutoff <cutoff>
```

## Releases

Releases go to npm as `@tibia.sh/tibiawiki-mcp`, starting at `0.1.0`.
[RELEASING.md](RELEASING.md) covers how a release is published and what to do
when one fails.

The version number describes the server, not the data. The index ships separately as
[`@tibia.sh/tibiawiki-data`](https://github.com/tibia-sh/tibiawiki-data), and its major
version is the index schema version. The server depends on `^3.1.0`. The major is the
schema it reads, and `3.1.0` is a floor: `MIN_DATA_VERSION` in `src/db.ts`, the first
data release whose index has every table and column `REQUIRED_COLUMNS` names. Generator
tables and columns can grow within a major, as `npc_location` and
`npc_destination.origin` did in `3.1.0`, so an older index of the same major would pass
npm and then fail the schema probe at startup. The floor keeps npm from installing it.
`test/data-package.test.ts` checks that the range is `^MIN_DATA_VERSION`, that its
major is `MCP_SCHEMA_VERSION` and that the installed data package is not below it. When a
tool starts reading a column only a later data release has, raise `MIN_DATA_VERSION` and
the range together.

The caret is a deliberate exception to this repository's exact pins. An exact `3.1.0`
would keep major 4 out just as well, so the caret is not what guards the schema. It lets
an install pick up each compatible data release without a
server release. `pnpm add` does not write `^3.1.0`, so edit the range by hand.

The tarball ships exactly `dist/`, `data/spell-areas.json` and
`data/tibiawikisql-requirements.txt`, plus the `package.json`,
`README.md` and `LICENSE` npm always adds; `test/packaging.test.ts` runs
`npm pack --dry-run` as part of `pnpm test`, so anything else leaking in fails CI.

`pnpm smoke <tarball-or-package@version>` is the consumer-side check: it installs the
package into a throwaway directory and drives the *installed* binary over real stdio and HTTP,
against a local tarball before publishing and against the registry after.
