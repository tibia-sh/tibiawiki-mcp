import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { GENERATOR_LOCK_PATH, GENERATOR_WHEEL_URL } from '../src/indexer/build-index.ts';
import { lockGenerator } from '../src/indexer/generator-lock.ts';

/**
 * Maintainer-run. Resolves the pinned generator and its dependencies with uv and writes
 * data/tibiawikisql-requirements.txt, the hash-locked file `build-index` installs from.
 * Needs `gh` signed in, to verify the generator wheel's attestation.
 *
 *   pnpm lock-generator                                  cutoff 7 days before now
 *   pnpm lock-generator --cutoff 2026-09-06T12:00:00Z    reproduce a lock from its header
 *
 * `lockGenerator` holds the sequence and every refusal. This file only wires the real
 * effects: the download, `gh`, `uv` and the write.
 *
 * Every run is a fresh resolution. uv compiles to stdout and never sees the committed
 * lock, which as an output file it would read back as preferences, letting the old pins
 * steer the new resolution. A refresh is a run with a later cutoff. A reproduction also
 * needs uv's own settings at their defaults: a uv.toml or a UV_* variable such as
 * UV_RESOLUTION changes the resolution without showing in the command.
 */

const { values } = parseArgs({ options: { cutoff: { type: 'string' } } });

const scratch = mkdtempSync(join(tmpdir(), 'tibiawiki-mcp-lock-'));
try {
  const { cutoff } = await lockGenerator({
    fetchWheel: async (url) => {
      // fetch follows the release download's redirect to its storage host.
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Downloading ${url} failed with HTTP ${response.status}, so the lock was not written.`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    attest: (wheel, flags) => {
      const file = join(scratch, decodeURIComponent(basename(new URL(GENERATOR_WHEEL_URL).pathname)));
      writeFileSync(file, wheel);
      // gh's findings and errors go straight to the terminal.
      const verified = spawnSync('gh', ['attestation', 'verify', file, ...flags], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      if (verified.error) throw verified.error;
      return verified.status;
    },
    uvVersion: () => execFileSync('uv', ['--version'], { encoding: 'utf8' }).trim(),
    // uv's progress and errors go straight to the terminal. Only the requirements are captured.
    compile: (args, input) =>
      execFileSync('uv', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }),
    dryRun: (lock, python, platform) => {
      const candidate = join(scratch, 'tibiawikisql-requirements.txt');
      writeFileSync(candidate, lock);
      const install = spawnSync('uv', [
        'pip', 'install', '--dry-run', '--target', mkdtempSync(join(scratch, 'target-')),
        '--python-platform', platform, '--python-version', python,
        '--require-hashes', '--no-build', '-r', candidate,
      ], { encoding: 'utf8' });
      if (install.error) throw install.error;
      return { status: install.status, stderr: install.stderr };
    },
    write: (lock) => writeFileSync(GENERATOR_LOCK_PATH, lock),
    log: (line) => process.stderr.write(`${line}\n`),
  }, { cutoff: values.cutoff });
  process.stderr.write(`Wrote ${GENERATOR_LOCK_PATH} with cutoff ${cutoff}.\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
