import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { GENERATOR, GENERATOR_LOCK_PATH, GENERATOR_PYTHON } from '../src/indexer/build-index.ts';

/**
 * Maintainer-run. Resolves the pinned generator and its dependencies with uv and writes
 * data/tibiawikisql-requirements.txt, the hash-locked file `build-index` installs from.
 *
 *   pnpm lock-generator                                  cutoff 7 days before now
 *   pnpm lock-generator --cutoff 2026-09-06T12:00:00Z    reproduce a lock from its header
 *
 * Every run is a fresh resolution. uv compiles to stdout and never sees the committed
 * lock, which as an output file it would read back as preferences, letting the old pins
 * steer the new resolution. A refresh is a run with a later cutoff.
 *
 * Before anything is written, a dry-run install checks the new lock on every CPython minor
 * version GENERATOR_PYTHON admits, for every platform in PLATFORMS. With `--no-build`, a
 * CPython that some dependency ships no wheel for fails here, not in `build-index` on
 * that CPython, and a lock that fails is never written.
 *
 * The header carries what a reproduction needs: the cutoff, the uv version, the Python
 * range and the command. uv's own header is left out. It would repeat the command
 * without the uv version or the requirement uv read on stdin. A reproduction also needs
 * uv's own settings at their defaults: a uv.toml or a UV_* variable such as
 * UV_RESOLUTION changes the resolution without showing in the command.
 */

/** Every CPython the range admits must install the lock on each of these without a build. */
const PLATFORMS = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The one form a cutoff is written and read in: a UTC time to the second. */
const utcSeconds = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

// The lock is compiled for the range's floor and checked on every minor version below
// its cap, as CPython, the only implementation the check proves. Any other shape would
// leave one of those undefined.
const bounds = /^cpython>=(\d+)\.(\d+),<(\d+)\.(\d+)$/.exec(GENERATOR_PYTHON);
if (!bounds || Number(bounds[1]) !== Number(bounds[3]) || Number(bounds[2]) >= Number(bounds[4])) {
  throw new Error(
    `GENERATOR_PYTHON must have the shape cpython>=X.Y,<X.Z with Y below Z, got "${GENERATOR_PYTHON}".`,
  );
}
const major = Number(bounds[1]);
const floorMinor = Number(bounds[2]);
const floor = `${major}.${floorMinor}`;
const pythons = Array.from(
  { length: Number(bounds[4]) - floorMinor },
  (_, i) => `${major}.${floorMinor + i}`,
);

const { values } = parseArgs({ options: { cutoff: { type: 'string' } } });
const cutoff = values.cutoff ?? utcSeconds(new Date(Date.now() - WEEK_MS));
// A bare date is local time to uv and a duration moves with the clock, so only an
// absolute UTC time names the same resolution twice. Round-tripping it also catches a
// date that does not exist, which Date would silently roll over.
const parsed = new Date(cutoff);
if (
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(cutoff) ||
  Number.isNaN(parsed.getTime()) ||
  utcSeconds(parsed) !== cutoff
) {
  throw new Error(`--cutoff must be an absolute UTC time such as 2026-09-06T12:00:00Z, got "${cutoff}".`);
}

const args = [
  'pip', 'compile', '-', '--universal', '--generate-hashes', '--no-build',
  '--python-version', floor, '--exclude-newer', cutoff, '--no-header',
];
const version = execFileSync('uv', ['--version'], { encoding: 'utf8' }).trim();
// uv's progress and errors go straight to the terminal. Only the requirements are captured.
const requirements = execFileSync('uv', args, {
  input: `${GENERATOR}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
});

const header = [
  `# ${GENERATOR} and every dependency, pinned and hashed. \`tibiawiki-mcp build-index\``,
  '# installs its generator from this file with `uv pip install --require-hashes`.',
  '# Written by `pnpm lock-generator` after a dry-run install without a build passed on',
  '# every CPython and platform under checked. Do not edit it by hand. To reproduce it, run',
  '# `pnpm lock-generator --cutoff <cutoff>` with the uv version below, and with no uv.toml',
  '# or UV_* variable of your own that changes how uv resolves, such as UV_INDEX_URL.',
  `# cutoff: ${cutoff}`,
  `# uv: ${version}`,
  `# python: ${GENERATOR_PYTHON}`,
  `# checked: CPython ${pythons.join(', ')} on ${PLATFORMS.join(', ')}`,
  `# command: echo '${GENERATOR}' | uv ${args.join(' ')}`,
];
const lock = `${header.join('\n')}\n${requirements}`;

const scratch = mkdtempSync(join(tmpdir(), 'tibiawiki-mcp-lock-'));
try {
  const candidate = join(scratch, 'tibiawikisql-requirements.txt');
  writeFileSync(candidate, lock);
  for (const python of pythons) {
    for (const platform of PLATFORMS) {
      const install = spawnSync('uv', [
        'pip', 'install', '--dry-run', '--target', mkdtempSync(join(scratch, 'target-')),
        '--python-platform', platform, '--python-version', python,
        '--require-hashes', '--no-build', '-r', candidate,
      ], { encoding: 'utf8' });
      if (install.error) throw install.error;
      if (install.status !== 0) {
        throw new Error(
          `The lock does not install without a build on CPython ${python} for ${platform} ` +
            `(uv exit ${install.status}), so it was not written.\n${install.stderr}`,
        );
      }
      process.stderr.write(`Checked CPython ${python} on ${platform}.\n`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

writeFileSync(GENERATOR_LOCK_PATH, lock);
process.stderr.write(`Wrote ${GENERATOR_LOCK_PATH} with cutoff ${cutoff}.\n`);
