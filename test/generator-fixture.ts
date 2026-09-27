import { readFileSync } from 'node:fs';
import { setGenerator } from '../scripts/set-generator.ts';
import { generatorWheelUrl } from '../src/indexer/generator-release.ts';

/**
 * build-index.ts and the lock as the generator tests start from, whatever the checkout pins.
 * generator.yml's prepare job moves the pin and then runs the suite, and the generator PR's own
 * CI runs it on the moved pin, so a test that moves the pin from the checked-in one would change
 * one line fewer once the checked-in one is already the version it moves to. These pin
 * FIXTURE_PINNED and FIXTURE_SHA instead, and every other line is the checked-in one.
 */

/** The generator version the fixture build-index.ts and lock pin. */
export const FIXTURE_PINNED = '9.0.0+tibiash.2';

/** The wheel sha256 the fixture build-index.ts and lock pin, which no real wheel has. */
export const FIXTURE_SHA = '0123456789abcdef'.repeat(4);

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** The lock entry of `version`'s wheel, hashed `sha256`, as uv writes it. */
export const generatorLockEntry = (version: string, sha256: string): string =>
  `tibiawikisql @ ${generatorWheelUrl(version)} \\\n    --hash=sha256:${sha256}\n`;

/** `text` with `from` replaced by `to`. Throws unless `from` is in `text` exactly once. */
const replaceOnce = (text: string, from: string, to: string): string => {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error(`Expected one ${JSON.stringify(from)}, found ${parts.length - 1}.`);
  return parts.join(to);
};

/** The checked-in build-index.ts, pinning FIXTURE_PINNED and FIXTURE_SHA. */
export const FIXTURE_BUILD_INDEX = setGenerator(read('src/indexer/build-index.ts'), FIXTURE_PINNED, FIXTURE_SHA);

/** The checked-in lock, with its one generator entry pinning FIXTURE_PINNED and FIXTURE_SHA. */
export const FIXTURE_LOCK = ((): string => {
  const lock = read('data/tibiawikisql-requirements.txt');
  const entries = lock.match(/^tibiawikisql @ \S+ \\\n {4}--hash=sha256:[0-9a-f]{64}\n/gm) ?? [];
  if (entries.length !== 1) throw new Error(`The checked-in lock has ${entries.length} generator entries, not one.`);
  return replaceOnce(lock, entries[0]!, generatorLockEntry(FIXTURE_PINNED, FIXTURE_SHA));
})();

/** FIXTURE_LOCK with its generator entry moved to `version`'s wheel, hashed `sha256`. */
export const lockFor = (version: string, sha256: string): string =>
  replaceOnce(FIXTURE_LOCK, generatorLockEntry(FIXTURE_PINNED, FIXTURE_SHA), generatorLockEntry(version, sha256));
