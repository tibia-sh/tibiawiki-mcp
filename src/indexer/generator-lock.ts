/**
 * Pure checks on a generator lock, the requirements file `uv pip compile --generate-hashes`
 * writes. `pnpm lock-generator` runs them before it writes a lock, and the test suite runs
 * them on the committed one.
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
