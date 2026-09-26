import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENERATOR } from '../src/indexer/build-index.ts';
import { assertGeneratorLocked, generatorEntry, lockEntries } from '../src/indexer/generator-lock.ts';

const ATTESTED = 'c0bbb67c7ffe31f2a6d8ad6f9338683e52c6f526c4ecceaf306ddbb792395d4a';
const OTHER = '6b779871820528bb800e96a46b38efdd3cd89355985e0b406da32d838e021a5b';

/** A lock as `uv pip compile --generate-hashes` writes one, around the generator's entry. */
const lock = (generator: string) =>
  [
    '# a header line',
    'requests==2.34.2 \\',
    `    --hash=sha256:${'a'.repeat(64)}`,
    '    # via tibiawikisql',
    generator,
    'typing-extensions==4.16.0 \\',
    `    --hash=sha256:${'b'.repeat(64)}`,
    '',
  ].join('\n');

const urlEntry = (...hashes: string[]) =>
  [`${GENERATOR} \\`, ...hashes.map((hash, i) =>
    `    --hash=sha256:${hash}${i < hashes.length - 1 ? ' \\' : ''}`)].join('\n');

test('a lock with one URL entry and one hash passes', () => {
  const entry = lock(urlEntry(ATTESTED));
  assert.deepEqual(generatorEntry(entry), { requirement: GENERATOR, hashes: [ATTESTED] });
  assert.doesNotThrow(() => assertGeneratorLocked(entry, GENERATOR, ATTESTED));
});

test('a generator entry with another hash throws, naming both hashes', () => {
  assert.throws(
    () => assertGeneratorLocked(lock(urlEntry(OTHER)), GENERATOR, ATTESTED),
    (error: Error) => error.message.includes(OTHER) && error.message.includes(ATTESTED),
  );
});

test('a generator entry with two hashes throws', () => {
  assert.throws(
    () => assertGeneratorLocked(lock(urlEntry(ATTESTED, OTHER)), GENERATOR, ATTESTED),
    /exactly one hash/,
  );
});

test('a lock without a tibiawikisql entry throws', () => {
  assert.throws(() => generatorEntry(lock('')), /found 0/);
  assert.throws(() => assertGeneratorLocked(lock(''), GENERATOR, ATTESTED), /found 0/);
  // A project whose name only starts with the generator's is another project.
  assert.throws(() => generatorEntry(lock(`tibiawikisql-extra==1.0 \\\n    --hash=sha256:${OTHER}`)), /found 0/);
});

test('a lock with two tibiawikisql entries throws', () => {
  const twice = lock(`${urlEntry(ATTESTED)}\n${urlEntry(ATTESTED)}`);
  assert.throws(() => generatorEntry(twice), /found 2/);
  // The name is matched as a project name, so another spelling of it is the same entry.
  const respelled = lock(`${urlEntry(ATTESTED)}\nTibiaWikiSQL==9.0.0 \\\n    --hash=sha256:${OTHER}`);
  assert.throws(() => generatorEntry(respelled), /found 2/);
});

test('a PyPI pin of the generator throws, since it is not the attested wheel', () => {
  const pypi = lock(`tibiawikisql==9.0.0 \\\n    --hash=sha256:${ATTESTED}`);
  assert.equal(generatorEntry(pypi).requirement, 'tibiawikisql==9.0.0');
  assert.throws(() => assertGeneratorLocked(pypi, GENERATOR, ATTESTED), /tibiawikisql==9\.0\.0/);
});

// uv ends a comment at the physical newline, so a backslash at the end of a comment does
// not continue it. Read the other way, the next line would hide inside the comment.
test('a requirement after a comment ending in a backslash is an entry of its own', () => {
  const hidden = `${lock(urlEntry(ATTESTED))}# note \\\n${GENERATOR} --hash=sha256:${OTHER}\n`;
  assert.throws(() => generatorEntry(hidden), /found 2/);
  assert.throws(() => assertGeneratorLocked(hidden, GENERATOR, ATTESTED), /found 2/);
});

test('a lock with comments reads as one entry per requirement', () => {
  const [a, b] = ['a'.repeat(64), 'b'.repeat(64)];
  assert.deepEqual(lockEntries([
    '# a header line, # and a second hash in it',
    'requests==2.34.2 \\',
    `    --hash=sha256:${a} \\`,
    `    --hash=sha256:${b}`,
    '    # via tibiawikisql',
    `idna==3.10 --hash=sha256:${a}  # an inline note`,
    'colorama==0.4.6 ; sys_platform == \'win32\' \\',
    `    --hash=sha256:${b}`,
    '',
  ].join('\n')), [
    `requests==2.34.2 --hash=sha256:${a} --hash=sha256:${b}`,
    `idna==3.10 --hash=sha256:${a}`,
    `colorama==0.4.6 ; sys_platform == 'win32' --hash=sha256:${b}`,
  ]);
});
