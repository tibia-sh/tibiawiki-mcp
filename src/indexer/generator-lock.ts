import { createHash } from 'node:crypto';
import {
  GENERATOR, GENERATOR_PYTHON, GENERATOR_SHA256, GENERATOR_VERSION, GENERATOR_WHEEL_URL,
} from './build-index.ts';
import {
  assertGeneratorLocked, attestationFlags, GENERATOR_SIGNER_WORKFLOW, generatorSourceRef, parseLock, type LockEntry,
} from './generator-release.ts';

/**
 * The sequence `pnpm lock-generator` writes the generator lock by, the requirements file
 * `uv pip compile --generate-hashes` writes. How a lock is read and checked lives in
 * generator-release.ts. The test suite runs the sequence with fake effects.
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

/**
 * Every effect `lockGenerator` has on the world, one function each, so the order and the
 * refusals around them live in `lockGenerator` and are tested with fakes.
 * `scripts/lock-generator.ts` wires the real ones.
 */
export interface LockSteps {
  /** The bytes at `url`, redirects followed. Throws on a failed download. */
  fetchWheel(url: string): Promise<Uint8Array>;
  /** Runs `gh attestation verify` on the wheel's bytes with these flags, and returns gh's exit status. */
  attest(wheel: Uint8Array, flags: readonly string[]): number | null;
  /** The output of `uv --version`. */
  uvVersion(): string;
  /** Runs `uv` with `args` and `input` on stdin, and returns its stdout. Throws on failure. */
  compile(args: readonly string[], input: string): string;
  /** A dry-run install of `lock` without a build for one CPython and platform, and uv's result. */
  dryRun(lock: string, python: string, platform: string): { status: number | null; stderr: string };
  /** Replaces the committed lock with `lock`. */
  write(lock: string): void;
  /** Reports progress, one line at a time. */
  log(line: string): void;
}

/**
 * Resolves the pinned generator and its dependencies and writes the lock, or throws with
 * nothing written. In order:
 *
 * 1. The arguments are checked. A bare date is local time to uv and a duration moves with
 *    the clock, so only an absolute UTC time names the same resolution twice. The default
 *    is 7 days before now.
 * 2. The generator wheel is downloaded, and refused unless its sha256 is the approved one,
 *    GENERATOR_SHA256.
 * 3. `gh attestation verify` must show that GENERATOR_SIGNER_WORKFLOW built it from
 *    the tag `v${GENERATOR_VERSION}` on a GitHub-hosted runner. The check runs here and not
 *    in `build-index`, which installs by hash alone: the hash a verified run writes carries
 *    the attestation to every build, with no `gh` on the building machine.
 * 4. uv compiles the lock for the range's floor. The cutoff applies to what uv resolves
 *    from PyPI only: the generator is a direct URL, which has no upload time.
 * 5. The lock must record that wheel with that one hash, and the header must read as a
 *    lock of comments alone, since it carries `uv --version`'s output.
 * 6. A dry-run install without a build must pass on every CPython minor version
 *    GENERATOR_PYTHON admits, for every platform in PLATFORMS. A CPython that some
 *    dependency ships no wheel for fails here, not in `build-index` on that CPython.
 * 7. The lock is written.
 *
 * The header carries what a reproduction needs: the cutoff, the uv version, the Python
 * range, the command, and the wheel and tag the attestation was verified for. uv's own
 * header is left out. It would repeat the command without the uv version or the
 * requirement uv read on stdin.
 *
 * `approvedSha256` is a test seam, and `scripts/lock-generator.ts` never passes it. It
 * defaults to GENERATOR_SHA256, and a test passes the digest of its fake wheel instead,
 * because it cannot produce the approved wheel's bytes.
 */
export async function lockGenerator(
  steps: LockSteps,
  options: { cutoff?: string; approvedSha256?: string } = {},
): Promise<{ cutoff: string }> {
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
  const pythons = Array.from({ length: Number(bounds[4]) - floorMinor }, (_, i) => `${major}.${floorMinor + i}`);

  const cutoff = options.cutoff ?? utcSeconds(new Date(Date.now() - WEEK_MS));
  // Round-tripping the cutoff also catches a date that does not exist, which Date would
  // silently roll over.
  const parsed = new Date(cutoff);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(cutoff) ||
    Number.isNaN(parsed.getTime()) ||
    utcSeconds(parsed) !== cutoff
  ) {
    throw new Error(`--cutoff must be an absolute UTC time such as 2026-09-06T12:00:00Z, got "${cutoff}".`);
  }
  const approved = options.approvedSha256 ?? GENERATOR_SHA256;
  const sourceRef = generatorSourceRef(GENERATOR_VERSION);

  const wheel = await steps.fetchWheel(GENERATOR_WHEEL_URL);
  const sha256 = createHash('sha256').update(wheel).digest('hex');
  if (sha256 !== approved) {
    throw new Error(
      `The wheel at ${GENERATOR_WHEEL_URL} is sha256:${sha256}, not the approved ` +
        `sha256:${approved}, so the lock was not written.`,
    );
  }

  const attested = steps.attest(wheel, attestationFlags(GENERATOR_VERSION));
  if (attested !== 0) {
    throw new Error(
      `\`gh attestation verify\` refused the wheel sha256:${sha256} for ${sourceRef} ` +
        `(gh exit ${attested}), so the lock was not written.`,
    );
  }
  steps.log(
    `Verified the attestation of sha256:${sha256}: built by ${GENERATOR_SIGNER_WORKFLOW} from ${sourceRef} ` +
      'on a GitHub-hosted runner.',
  );

  const args = [
    'pip', 'compile', '-', '--universal', '--generate-hashes', '--no-build',
    '--python-version', `${major}.${floorMinor}`, '--exclude-newer', cutoff, '--no-header',
  ];
  const version = steps.uvVersion();
  const requirements = steps.compile(args, `${GENERATOR}\n`);
  // The lock must install exactly the wheel just verified, and nothing else in its place.
  assertGeneratorLocked(requirements, GENERATOR, sha256);

  const header = [
    `# tibiawikisql ${GENERATOR_VERSION} and every dependency, pinned and hashed. \`tibiawiki-mcp build-index\``,
    '# installs its generator from this file with `uv pip install --require-hashes`.',
    '# Written by `pnpm lock-generator` after `gh attestation verify` passed for the generator',
    '# wheel and tag under attested, and a dry-run install without a build passed on every',
    '# CPython and platform under checked. Do not edit it by hand. To reproduce it, run',
    '# `pnpm lock-generator --cutoff <cutoff>` with the uv version below, and with no uv.toml',
    '# or UV_* variable of your own that changes how uv resolves, such as UV_INDEX_URL.',
    `# cutoff: ${cutoff}`,
    `# uv: ${version}`,
    `# python: ${GENERATOR_PYTHON}`,
    `# checked: CPython ${pythons.join(', ')} on ${PLATFORMS.join(', ')}`,
    `# attested: sha256:${sha256} ${sourceRef}`,
    `# command: echo '${GENERATOR}' | uv ${args.join(' ')}`,
  ];
  const headerText = `${header.join('\n')}\n`;
  // The header carries uv's own output. A line break in it would start a line of its own,
  // which parseLock reads as a requirement, so the header must parse with no entries.
  let headerEntries: LockEntry[];
  try {
    headerEntries = parseLock(headerText, GENERATOR);
  } catch (error) {
    throw new Error(`The lock's header is not comments alone, so the lock was not written. ${(error as Error).message}`);
  }
  if (headerEntries.length !== 0) {
    throw new Error(
      `The lock's header holds requirement lines (${headerEntries.map((entry) => entry.name).join(', ')}), ` +
        'not comments alone, so the lock was not written.',
    );
  }
  const lock = `${headerText}${requirements}`;

  for (const python of pythons) {
    for (const platform of PLATFORMS) {
      const install = steps.dryRun(lock, python, platform);
      if (install.status !== 0) {
        throw new Error(
          `The lock does not install without a build on CPython ${python} for ${platform} ` +
            `(uv exit ${install.status}), so it was not written.\n${install.stderr}`,
        );
      }
      steps.log(`Checked CPython ${python} on ${platform}.`);
    }
  }

  steps.write(lock);
  return { cutoff };
}
