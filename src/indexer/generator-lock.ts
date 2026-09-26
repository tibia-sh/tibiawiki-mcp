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

/** One requirement of a lock: its PEP 503 normalized name, the requirement as written, and its sha256 digests. */
export interface LockEntry {
  name: string;
  requirement: string;
  hashes: string[];
}

/** A pinned dependency as uv writes it: `name==version`, with an optional ` ; <marker>`. */
const PINNED = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)==([0-9][0-9A-Za-z.!+_-]*)(?: ; (.+))?$/;

/** One hash of the entry above, and ` \` when another hash follows. */
const HASH = /^ {4}--hash=sha256:([0-9a-f]{64})( \\)?$/;

/** The indented notes uv writes under an entry: `# via x`, or `# via` and then `#   x` lines. */
const VIA = /^ {4}# via(?: \S.*)?$|^ {4}# {3}\S+$/;

const lineError = (index: number, line: string, why: string): Error =>
  new Error(`Line ${index + 1} of the lock ${why}: ${JSON.stringify(line)}`);

/**
 * Reads a lock that must be exactly what `uv pip compile --generate-hashes` writes, and
 * rejects anything else, naming the line. pip and uv read a requirements file more
 * leniently than this, and every leniency has let a line hide from a looser reader, so
 * the grammar is closed:
 *
 * - The text is printable ASCII and LF, and nothing else. Lines end in LF alone: pip and
 *   uv also end a line at a bare CR, and pip at every other break Python's splitlines()
 *   knows, such as VT, FF, U+001C to U+001E, U+0085, U+2028 and U+2029. Tabs, NUL and
 *   the rest are no part of what uv writes.
 * - No line is an encoding declaration (PEP 263's `coding:` or `coding=`). pip decodes the
 *   file by one before it parses it, and `unicode_escape` would turn a literal `\x0a` in a
 *   comment into a line break.
 * - No line holds a `$`. pip and uv substitute `${VAR}` from the environment, so one would
 *   let the building machine's environment change what the lock installs.
 * - A line starting with `#` is a comment. The indented `# via` notes uv writes are allowed
 *   right after an entry's last hash.
 * - An entry is `name==version`, with an optional ` ; <marker>`, or exactly GENERATOR,
 *   and ends in ` \`. Its hashes follow one per line, `    --hash=sha256:` and 64
 *   lowercase hex digits, each but the last ending in ` \`. A marker holds no `#` or `\`,
 *   and no word starting with `-`, which pip would read as the start of its options.
 * - Nothing else: no option lines such as `-r`, `-e`, `-c` or `--index-url`, no blank
 *   lines, no entry without a hash, no text after a hash, and no project twice.
 */
export function parseLock(lock: string): LockEntry[] {
  const outside = /[^\x20-\x7e\n]/u.exec(lock);
  if (outside) {
    // Everything before it is ASCII, so the column counts characters.
    const before = lock.slice(0, outside.index);
    const code = outside[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
    throw new Error(
      `Line ${before.split('\n').length}, column ${outside.index - before.lastIndexOf('\n')} of the lock ` +
        `has U+${code}. A lock holds printable ASCII and LF only.`,
    );
  }
  const lines = lock.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const entries: LockEntry[] = [];
  // The entry whose last line ended in ` \`, so its next hash line comes next.
  let open: LockEntry | undefined;
  // Whether the line above ended an entry, or was a `# via` note under it.
  let underEntry = false;
  for (const [index, line] of lines.entries()) {
    if (/coding[:=]/.test(line)) {
      throw lineError(index, line, 'is an encoding declaration, which pip would decode the lock by');
    }
    const dollar = line.indexOf('$');
    if (dollar !== -1) {
      throw new Error(
        `Line ${index + 1}, column ${dollar + 1} of the lock has a $. ` +
          'pip and uv would substitute ${VAR} from the environment, so a lock holds none.',
      );
    }
    const hash = HASH.exec(line);
    if (open) {
      if (!hash) throw lineError(index, line, `should be the next --hash=sha256 line of ${open.name}`);
      open.hashes.push(hash[1]!);
      if (hash[2] === undefined) {
        open = undefined;
        underEntry = true;
      }
      continue;
    }
    if (hash) throw lineError(index, line, 'is a hash outside an entry');
    if (VIA.test(line)) {
      if (!underEntry) throw lineError(index, line, 'is a via note outside an entry');
      continue;
    }
    underEntry = false;
    if (line.startsWith('#')) continue;
    if (!line.endsWith(' \\')) {
      throw lineError(index, line, 'is not a requirement with its hashes on the lines below');
    }
    const requirement = line.slice(0, -2);
    let name = GENERATOR_NAME;
    if (requirement !== GENERATOR) {
      const pinned = PINNED.exec(requirement);
      if (!pinned) throw lineError(index, line, 'is neither name==version nor the generator');
      const marker = pinned[3];
      if (marker !== undefined && /[#\\]|(?:^|\s)-/.test(marker)) {
        throw lineError(index, line, 'has a marker uv does not write');
      }
      name = pinned[1]!.toLowerCase().replace(/[-_.]+/g, '-');
    }
    if (entries.some((entry) => entry.name === name)) {
      throw lineError(index, line, `names ${name} a second time`);
    }
    open = { name, requirement, hashes: [] };
    entries.push(open);
  }
  if (open) {
    const last = lines.length - 1;
    throw lineError(
      last, lines[last]!, `ends in a backslash, but the lock ends there, before the last hash of ${open.name}`,
    );
  }
  return entries;
}

/**
 * The lock's one `tibiawikisql` entry: the requirement as written, and the sha256 digests
 * of its hashes. Throws on a lock `parseLock` rejects, and on one without that entry.
 */
export function generatorEntry(lock: string): { requirement: string; hashes: string[] } {
  const found = parseLock(lock).filter((entry) => entry.name === GENERATOR_NAME);
  if (found.length !== 1) {
    throw new Error(`The lock must have exactly one ${GENERATOR_NAME} entry, found ${found.length}.`);
  }
  const { requirement, hashes } = found[0]!;
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
