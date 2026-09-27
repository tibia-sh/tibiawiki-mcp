/**
 * A generator release: where it lives, how its version is written, how its attestation is
 * verified, and how the lock that installs it is read and checked. This file imports
 * nothing, so a job that holds a token can run it from its own checkout without installing
 * a dependency.
 */

/** The repository whose release workflow builds and attests the generator wheel. */
export const GENERATOR_REPO = 'tibia-sh/tibiawiki-sql';

/** The workflow that builds and attests the generator wheel, as `gh attestation verify` names a signer. */
export const GENERATOR_SIGNER_WORKFLOW = `${GENERATOR_REPO}/.github/workflows/release.yml`;

/**
 * A generator version, whole: a base x.y.z and the tibia-sh release number. A trailing
 * newline fails, since `$` without flags matches only at the end of the string.
 */
export const GENERATOR_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+\+tibiash\.[0-9]+$/;

/** Throws unless `version` is a whole generator version. */
export function assertGeneratorVersion(version: string): void {
  if (!GENERATOR_VERSION_PATTERN.test(version)) {
    throw new Error(`${JSON.stringify(version)} is not a generator version such as 9.0.0+tibiash.2.`);
  }
}

/**
 * The wheel of a generator release, as its GitHub release asset. The `+` in the tag is
 * percent-encoded in the path, and not in the file name.
 */
export function generatorWheelUrl(version: string): string {
  return `https://github.com/${GENERATOR_REPO}/releases/download/v${encodeURIComponent(version)}` +
    `/tibiawikisql-${version}-py3-none-any.whl`;
}

/** The tag a generator release is built from. */
export function generatorSourceRef(version: string): string {
  return `refs/tags/v${version}`;
}

/**
 * The flags `gh attestation verify` checks a generator wheel with: GENERATOR_REPO's release
 * workflow built it from the tag of `version`, on a GitHub-hosted runner. Throws on a
 * version that is not whole.
 */
export function attestationFlags(version: string): string[] {
  assertGeneratorVersion(version);
  return [
    '--repo', GENERATOR_REPO,
    '--signer-workflow', GENERATOR_SIGNER_WORKFLOW,
    '--source-ref', generatorSourceRef(version),
    '--deny-self-hosted-runners',
  ];
}

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
 * - An entry is `name==version`, with an optional ` ; <marker>`, or exactly `generator`,
 *   the one requirement the caller takes as the generator's, and ends in ` \`. Its hashes
 *   follow one per line, `    --hash=sha256:` and 64 lowercase hex digits, each but the
 *   last ending in ` \`. A marker holds no `#` or `\`,
 *   and no word starting with `-`, which pip would read as the start of its options.
 * - Nothing else: no option lines such as `-r`, `-e`, `-c` or `--index-url`, no blank
 *   lines, no entry without a hash, no text after a hash, and no project twice.
 */
export function parseLock(lock: string, generator: string): LockEntry[] {
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
    if (requirement !== generator) {
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
 * of its hashes. Throws on a lock `parseLock` rejects with `generator`, and on one without
 * that entry.
 */
export function generatorEntry(lock: string, generator: string): { requirement: string; hashes: string[] } {
  const found = parseLock(lock, generator).filter((entry) => entry.name === GENERATOR_NAME);
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
  const entry = generatorEntry(lock, requirement);
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
