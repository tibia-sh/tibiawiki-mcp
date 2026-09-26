import { createHash } from 'node:crypto';
import {
  GENERATOR, GENERATOR_PYTHON, GENERATOR_REPO, GENERATOR_SHA256, GENERATOR_VERSION, GENERATOR_WHEEL_URL,
} from './build-index.ts';

/**
 * The generator lock, the requirements file `uv pip compile --generate-hashes` writes: how
 * it is read and checked, and the sequence `pnpm lock-generator` writes it by. The test
 * suite runs the checks on the committed lock, and runs the sequence with fake effects.
 */

/** The generator's PEP 503 normalized project name. */
const GENERATOR_NAME = 'tibiawikisql';

/**
 * The lock's requirements as uv reads them, one string each, whitespace collapsed. A
 * comment (`#` at the start of a line or after whitespace) is dropped from each physical
 * line first, and only then does a trailing backslash join a line to the next. uv ends a
 * comment at the newline, so a backslash inside one continues nothing, and the next line
 * is a requirement of its own that must not hide inside the comment.
 */
export function lockEntries(lock: string): string[] {
  const found: string[] = [];
  let entry = '';
  const end = () => {
    const text = entry.trim().replace(/\s+/g, ' ');
    if (text !== '') found.push(text);
    entry = '';
  };
  for (const physical of lock.split('\n')) {
    const line = physical.replace(/(?:^|\s)#.*/, '').trimEnd();
    if (line.endsWith('\\')) {
      entry += `${line.slice(0, -1)} `;
    } else {
      entry += line;
      end();
    }
  }
  end();
  return found;
}

/** A requirement's project name, normalized as PEP 503 compares names. */
const projectName = (entry: string): string =>
  (/^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(entry)?.[0] ?? '').toLowerCase().replace(/[-_.]+/g, '-');

/**
 * The lock's one `tibiawikisql` entry: the requirement as written, without its `--hash`
 * options, and the sha256 digests those options name. Throws unless there is exactly one
 * such entry, and on any hash that is not a sha256 digest.
 */
export function generatorEntry(lock: string): { requirement: string; hashes: string[] } {
  const found = lockEntries(lock).filter((entry) => projectName(entry) === GENERATOR_NAME);
  if (found.length !== 1) {
    throw new Error(`The lock must have exactly one ${GENERATOR_NAME} entry, found ${found.length}.`);
  }
  const [requirement = '', ...options] = found[0]!.split(' --hash=');
  const hashes = options.map((option) => {
    const digest = /^sha256:([0-9a-f]{64})$/.exec(option)?.[1];
    if (digest === undefined) throw new Error(`The ${GENERATOR_NAME} entry has a hash that is not sha256: ${option}`);
    return digest;
  });
  return { requirement, hashes };
}

/**
 * Throws unless the lock's `tibiawikisql` entry is exactly `requirement`, hashed with
 * exactly `sha256` and nothing else. A second hash would let uv accept a second file.
 */
export function assertGeneratorLocked(lock: string, requirement: string, sha256: string): void {
  const entry = generatorEntry(lock);
  if (entry.requirement !== requirement) {
    throw new Error(`The lock's generator entry is "${entry.requirement}", not "${requirement}".`);
  }
  if (entry.hashes.length !== 1) {
    throw new Error(
      `The lock's generator entry must have exactly one hash, sha256:${sha256}, ` +
        `but has ${entry.hashes.length}: ${entry.hashes.join(', ')}.`,
    );
  }
  if (entry.hashes[0] !== sha256) {
    throw new Error(
      `The lock records the generator wheel sha256:${entry.hashes[0]}, ` +
        `but the attested wheel is sha256:${sha256}.`,
    );
  }
}

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
 * 3. `gh attestation verify` must show that GENERATOR_REPO's release workflow built it from
 *    the tag `v${GENERATOR_VERSION}` on a GitHub-hosted runner. The check runs here and not
 *    in `build-index`, which installs by hash alone: the hash a verified run writes carries
 *    the attestation to every build, with no `gh` on the building machine.
 * 4. uv compiles the lock for the range's floor. The cutoff applies to what uv resolves
 *    from PyPI only: the generator is a direct URL, which has no upload time.
 * 5. The lock must record that wheel with that one hash.
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
 * `approvedSha256` is GENERATOR_SHA256 unless a test passes the digest of its fake wheel.
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
  const signerWorkflow = `${GENERATOR_REPO}/.github/workflows/release.yml`;
  const sourceRef = `refs/tags/v${GENERATOR_VERSION}`;

  const wheel = await steps.fetchWheel(GENERATOR_WHEEL_URL);
  const sha256 = createHash('sha256').update(wheel).digest('hex');
  if (sha256 !== approved) {
    throw new Error(
      `The wheel at ${GENERATOR_WHEEL_URL} is sha256:${sha256}, not the approved ` +
        `sha256:${approved}, so the lock was not written.`,
    );
  }

  const attested = steps.attest(wheel, [
    '--repo', GENERATOR_REPO, '--signer-workflow', signerWorkflow, '--source-ref', sourceRef,
    '--deny-self-hosted-runners',
  ]);
  if (attested !== 0) {
    throw new Error(
      `\`gh attestation verify\` refused the wheel sha256:${sha256} for ${sourceRef} ` +
        `(gh exit ${attested}), so the lock was not written.`,
    );
  }
  steps.log(
    `Verified the attestation of sha256:${sha256}: built by ${signerWorkflow} from ${sourceRef} ` +
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
  const lock = `${header.join('\n')}\n${requirements}`;

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
