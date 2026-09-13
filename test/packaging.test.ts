import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A published tarball cannot be taken back, so the only moment this is checkable is
 * before the publish. `files` in package.json is all that keeps the plugin skill, the
 * scripts and the test fixtures out of it, and until now the only thing checking
 * `files` was a maintainer remembering to read `npm pack --dry-run` by eye.
 *
 * The rule is a permitted-path allowlist, never a file count or a byte size:
 * package.json and README.md change routinely and dist/ grows with every new source
 * file, so any fixed number would be wrong by the next commit.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

// npm always adds these three regardless of `files`.
const ALWAYS_ADDED = ['package.json', 'README.md', 'LICENSE'];

// build-index reads both at run time: the spell area shapes, and the generator's lock.
const DATA_FILES = ['data/spell-areas.json', 'data/tibiawikisql-requirements.txt'];

const isPermitted = (path: string): boolean =>
  path.startsWith('dist/') || DATA_FILES.includes(path) || ALWAYS_ADDED.includes(path);

type PackReport = { files: Array<{ path: string }> };

// `pnpm test` exports this repo's pnpm-workspace.yaml to its children as npm_config_*,
// and npm warns it will hard-error on every one of them in a future major - which would
// turn this test red for a reason that has nothing to do with packaging. Nothing about
// the packed file list depends on them. scripts/smoke.mjs strips the same lowercase
// prefix for the same reason, and both keep NPM_CONFIG_* because that spelling is the
// operator's own registry, proxy and CA. Two call sites, one predicate: a shared module
// would cost more than it saves, and smoke.mjs cannot be imported from - it is a script
// that runs on load.
const consumerEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('npm_')),
);

const packedPaths = (): string[] => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root, env: consumerEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  // npm keys the report by package name - `@tibia.sh/tibiawiki-mcp` - not by index.
  // Older npm emitted a one-element array instead; both carry the same entry.
  const parsed = JSON.parse(out) as PackReport[] | Record<string, PackReport>;
  const [report] = Array.isArray(parsed) ? parsed : Object.values(parsed);
  assert.ok(report, `npm pack reported no package: ${out.slice(0, 200)}`);
  return report.files.map((f) => f.path);
};

// One pack, read by both tests: it spawns npm and tars the tree.
const packed = packedPaths();

test('the tarball ships dist/ and the data files, and nothing else', () => {
  assert.deepEqual(
    packed.filter((p) => !isPermitted(p)),
    [],
    `files in package.json now ships more than dist/ + ${DATA_FILES.join(' + ')}`,
  );
});

// Without this the allowlist above would pass just as happily on an empty tarball.
test('the binary and the data files really are in the tarball', () => {
  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { bin: Record<string, string> };
  const bin = pkg.bin['tibiawiki-mcp'];
  assert.ok(bin, 'package.json must declare the tibiawiki-mcp bin');
  assert.ok(packed.includes(bin), `${bin} is not in the tarball; the package has no server`);
  assert.ok(packed.includes('data/spell-areas.json'), 'no data file means no index can be built');
  assert.ok(
    packed.includes('data/tibiawikisql-requirements.txt'),
    'no lock means build-index cannot install the generator',
  );
});
