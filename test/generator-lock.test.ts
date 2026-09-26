import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GENERATOR, GENERATOR_VERSION, GENERATOR_WHEEL_URL } from '../src/indexer/build-index.ts';
import {
  assertGeneratorLocked, generatorEntry, lockGenerator, parseLock, type LockSteps,
} from '../src/indexer/generator-lock.ts';

const ATTESTED = 'c0bbb67c7ffe31f2a6d8ad6f9338683e52c6f526c4ecceaf306ddbb792395d4a';
const OTHER = '6b779871820528bb800e96a46b38efdd3cd89355985e0b406da32d838e021a5b';

/** A lock as `uv pip compile --generate-hashes` writes one, around the generator's entry, if any. */
const lock = (generator: string) =>
  [
    '# a header line',
    'requests==2.34.2 \\',
    `    --hash=sha256:${'a'.repeat(64)}`,
    '    # via tibiawikisql',
    ...(generator === '' ? [] : [generator]),
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
  assert.throws(() => generatorEntry(twice), /names tibiawikisql a second time/);
  // The name is matched as a project name, so another spelling of it is the same entry.
  const respelled = lock(`${urlEntry(ATTESTED)}\nTibiaWikiSQL==9.0.0 \\\n    --hash=sha256:${OTHER}`);
  assert.throws(() => generatorEntry(respelled), /names tibiawikisql a second time/);
});

test('a PyPI pin of the generator throws, since it is not the attested wheel', () => {
  const pypi = lock(`tibiawikisql==9.0.0 \\\n    --hash=sha256:${ATTESTED}`);
  assert.equal(generatorEntry(pypi).requirement, 'tibiawikisql==9.0.0');
  assert.throws(() => assertGeneratorLocked(pypi, GENERATOR, ATTESTED), /tibiawikisql==9\.0\.0/);
});

// uv ends a comment at the physical newline, so a backslash at the end of a comment does
// not continue it. Read the other way, the next line would hide inside the comment.
test('a requirement after a comment ending in a backslash is rejected', () => {
  const hidden = `${lock(urlEntry(ATTESTED))}# note \\\n${GENERATOR} --hash=sha256:${OTHER}\n`;
  assert.throws(() => generatorEntry(hidden), /Line 10 of the lock is not a requirement with its hashes/);
  assert.throws(() => assertGeneratorLocked(hidden, GENERATOR, ATTESTED), /Line 10 of the lock/);
});

test('parseLock reads a lock with markers, via notes and several hashes per entry', () => {
  const [a, b] = ['a'.repeat(64), 'b'.repeat(64)];
  assert.deepEqual(parseLock([
    '# a header line, # and a second hash in it',
    'requests==2.34.2 \\',
    `    --hash=sha256:${a} \\`,
    `    --hash=sha256:${b}`,
    '    # via tibiawikisql',
    'Typing_Extensions==4.16.0 \\',
    `    --hash=sha256:${a}`,
    '    # via',
    '    #   pydantic',
    '    #   pypika',
    'colorama==0.4.6 ; sys_platform == \'win32\' \\',
    `    --hash=sha256:${b}`,
    `${GENERATOR} \\`,
    `    --hash=sha256:${ATTESTED}`,
    '',
  ].join('\n')), [
    { name: 'requests', requirement: 'requests==2.34.2', hashes: [a, b] },
    { name: 'typing-extensions', requirement: 'Typing_Extensions==4.16.0', hashes: [a] },
    { name: 'colorama', requirement: "colorama==0.4.6 ; sys_platform == 'win32'", hashes: [b] },
    { name: 'tibiawikisql', requirement: GENERATOR, hashes: [ATTESTED] },
  ]);
});

/** Each is a lock uv would not write, and the line parseLock must name in rejecting it. */
const HASH_A = `    --hash=sha256:${'a'.repeat(64)}`;
const REJECTED: Array<[string, string, RegExp]> = [
  ['CRLF line endings', `requests==2.34.2 \\\r\n${HASH_A}\r\n`, /Line 1, column 19 of the lock has U\+000D\./],
  ['a -r line', `-r other.txt\nrequests==2.34.2 \\\n${HASH_A}\n`, /Line 1 of the lock is not a requirement/],
  ['an --index-url line', `--index-url https://example.invalid/simple \\\n${HASH_A}\n`, /Line 1 of the lock is neither/],
  ['a -e line', `-e ./local \\\n${HASH_A}\n`, /Line 1 of the lock is neither/],
  ['a duplicate dependency', `requests==2.34.2 \\\n${HASH_A}\nRequests==2.34.1 \\\n${HASH_A}\n`, /Line 3 of the lock names requests a second time/],
  ['an entry without a hash', 'requests==2.34.2\n', /Line 1 of the lock is not a requirement with its hashes/],
  ['an entry whose hashes never come', `requests==2.34.2 \\\n${HASH_A} \\\n`, /Line 2 of the lock ends in a backslash, but the lock ends there, before the last hash of requests/],
  ['a hash in uppercase hex', `requests==2.34.2 \\\n    --hash=sha256:${'A'.repeat(64)}\n`, /Line 2 of the lock should be the next --hash/],
  ['text after a hash', `requests==2.34.2 \\\n${HASH_A} --hash=sha256:${'b'.repeat(64)}\n`, /Line 2 of the lock should be the next --hash/],
  ['a blank line inside an entry', `requests==2.34.2 \\\n\n${HASH_A}\n`, /Line 2 of the lock should be the next --hash/],
  ['a blank line between entries', `requests==2.34.2 \\\n${HASH_A}\n\nidna==3.19 \\\n${HASH_A}\n`, /Line 3 of the lock is not a requirement/],
  ['a stray hash', `requests==2.34.2 \\\n${HASH_A}\n${HASH_A}\n`, /Line 3 of the lock is a hash outside an entry/],
  ['a via note before any entry', `    # via requests\nrequests==2.34.2 \\\n${HASH_A}\n`, /Line 1 of the lock is a via note outside an entry/],
  ['a marker with an option in it', `requests==2.34.2 ; python_version > "3" --hash=sha256:${'b'.repeat(64)} \\\n${HASH_A}\n`, /Line 1 of the lock has a marker uv does not write/],
  ['another URL for the generator', `tibiawikisql @ https://example.invalid/t.whl \\\n${HASH_A}\n`, /Line 1 of the lock is neither/],
];
// pip splits lines with Python's splitlines(), which ends a line at each of these too, and
// a tab or NUL is no part of what uv writes. Each would hide a second generator entry in a
// comment from a reader that ends lines at LF.
const HIDING: Array<[string, string]> = [
  ['U+0085', '\u0085'], ['U+2028', '\u2028'], ['U+2029', '\u2029'], ['VT', '\x0b'], ['FF', '\x0c'],
  ['U+001C', '\x1c'], ['a tab', '\t'], ['NUL', '\0'],
];
for (const [what, char] of HIDING) {
  test(`parseLock rejects ${what}, naming its line and column`, () => {
    const hidden = `# note${char}${GENERATOR} \\\n${lock(urlEntry(ATTESTED))}`;
    const code = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
    assert.throws(() => parseLock(hidden), new RegExp(`^Error: Line 1, column 7 of the lock has U\\+${code}\\.`));
    assert.throws(() => assertGeneratorLocked(hidden, GENERATOR, ATTESTED), /Line 1, column 7/);
  });
}

// pip decodes the file by an encoding declaration before it parses it, so
// `unicode_escape` would turn a literal \x0a in a later comment into a line break.
for (const declaration of ['# coding: unicode_escape', '# -*- coding: latin-1 -*-']) {
  test(`parseLock rejects the encoding declaration ${declaration}`, () => {
    const declared = `# a header line\n${declaration}\n${lock(urlEntry(ATTESTED))}`;
    assert.throws(() => parseLock(declared), /Line 2 of the lock is an encoding declaration/);
  });
}

// pip and uv substitute ${VAR} from the environment, so a $ would let the environment
// change what the lock installs.
const DOLLARS: Array<[string, string, RegExp]> = [
  ['a ${VAR} marker', `# a header line\nrequests==2.34.2 ; python_version != '\${LOCK_MARKER}' \\\n${HASH_A}\n`, /^Error: Line 2, column 39 of the lock has a \$\./],
  ['a bare $', `# costs $5\nrequests==2.34.2 \\\n${HASH_A}\n`, /^Error: Line 1, column 9 of the lock has a \$\./],
];
for (const [what, text, error] of DOLLARS) {
  test(`parseLock rejects ${what}, naming its line and column`, () => {
    assert.throws(() => parseLock(text), error);
  });
}

for (const [what, text, error] of REJECTED) {
  test(`parseLock rejects ${what}`, () => {
    assert.throws(() => parseLock(text), error);
  });
}

/**
 * Fake effects for `lockGenerator`, recording each call in order. The wheel is a few bytes,
 * so the run approves their digest in place of GENERATOR_SHA256, and by default uv compiles
 * a lock that records exactly that wheel. `attestStatus`, `requirements` and `failDryRun`
 * make one step fail the way the real one reports it.
 */
function fakeSteps(opts: { attestStatus?: number; requirements?: (digest: string) => string; failDryRun?: string } = {}) {
  const wheel = new TextEncoder().encode('not a real wheel');
  const digest = createHash('sha256').update(wheel).digest('hex');
  const calls: string[] = [];
  const seen: { flags?: readonly string[]; attested?: Uint8Array; compiled?: string; dryRun: string[]; written?: string } =
    { dryRun: [] };
  const steps: LockSteps = {
    fetchWheel: async (url) => { calls.push(`fetch ${url}`); return wheel; },
    attest: (bytes, flags) => {
      calls.push('attest');
      seen.attested = bytes;
      seen.flags = flags;
      return opts.attestStatus ?? 0;
    },
    uvVersion: () => { calls.push('uv --version'); return 'uv 0.12.18 (test)'; },
    compile: (args, input) => {
      calls.push(`compile ${args.join(' ')}`);
      seen.compiled = input;
      return (opts.requirements ?? ((d) => `${GENERATOR} \\\n    --hash=sha256:${d}\n`))(digest);
    },
    dryRun: (lock, python, platform) => {
      calls.push(`dry run ${python} ${platform}`);
      seen.dryRun.push(lock);
      return `${python} ${platform}` === opts.failDryRun
        ? { status: 1, stderr: 'no wheel for this platform' }
        : { status: 0, stderr: '' };
    },
    write: (lock) => { calls.push('write'); seen.written = lock; },
    log: () => {},
  };
  return { steps, calls, seen, digest, wheel };
}

const CUTOFF = '2026-09-06T15:36:25Z';
const PLATFORMS = [
  'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu', 'x86_64-apple-darwin', 'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
];
const COMPILE =
  `compile pip compile - --universal --generate-hashes --no-build --python-version 3.10 --exclude-newer ${CUTOFF} --no-header`;

test('lockGenerator refuses a bad cutoff before any step runs', async () => {
  const fake = fakeSteps();
  await assert.rejects(
    lockGenerator(fake.steps, { cutoff: '2026-09-06', approvedSha256: fake.digest }),
    /--cutoff must be an absolute UTC time/,
  );
  assert.deepEqual(fake.calls, []);
});

test('lockGenerator runs fetch, attest, compile, the dry runs and the write in that order', async () => {
  const fake = fakeSteps();
  const result = await lockGenerator(fake.steps, { cutoff: CUTOFF, approvedSha256: fake.digest });
  assert.deepEqual(result, { cutoff: CUTOFF });
  const dryRuns = ['3.10', '3.11', '3.12', '3.13'].flatMap((python) =>
    PLATFORMS.map((platform) => `dry run ${python} ${platform}`));
  assert.deepEqual(fake.calls, [
    `fetch ${GENERATOR_WHEEL_URL}`, 'attest', 'uv --version', COMPILE, ...dryRuns, 'write',
  ]);
  assert.equal(fake.seen.compiled, `${GENERATOR}\n`);
  const written = fake.seen.written ?? '';
  assert.ok(
    written.split('\n').includes(`# attested: sha256:${fake.digest} refs/tags/v${GENERATOR_VERSION}`),
    `the header has no attested line for the wheel:\n${written}`,
  );
  assert.ok(written.endsWith(`${GENERATOR} \\\n    --hash=sha256:${fake.digest}\n`), 'the lock ends with what uv compiled');
  // Every dry run checked the lock that was written.
  assert.deepEqual(new Set(fake.seen.dryRun), new Set([written]));
});

test('lockGenerator verifies the attestation with exactly the release workflow flags', async () => {
  const fake = fakeSteps();
  await lockGenerator(fake.steps, { cutoff: CUTOFF, approvedSha256: fake.digest });
  assert.deepEqual(fake.seen.attested, fake.wheel, 'the attested bytes are the downloaded wheel');
  assert.deepEqual(fake.seen.flags, [
    '--repo', 'tibia-sh/tibiawiki-sql',
    '--signer-workflow', 'tibia-sh/tibiawiki-sql/.github/workflows/release.yml',
    '--source-ref', `refs/tags/v${GENERATOR_VERSION}`,
    '--deny-self-hosted-runners',
  ]);
});

test('lockGenerator refuses a wheel whose digest is not the approved one, before attest, compile or write', async () => {
  const fake = fakeSteps();
  // No approvedSha256: the approved digest is GENERATOR_SHA256, which these bytes are not.
  await assert.rejects(
    lockGenerator(fake.steps, { cutoff: CUTOFF }),
    (error: Error) => error.message.includes(fake.digest) && /not the approved/.test(error.message),
  );
  assert.deepEqual(fake.calls, [`fetch ${GENERATOR_WHEEL_URL}`]);
});

test('lockGenerator stops on a failed attestation, before compile or write', async () => {
  const fake = fakeSteps({ attestStatus: 1 });
  await assert.rejects(
    lockGenerator(fake.steps, { cutoff: CUTOFF, approvedSha256: fake.digest }),
    /gh attestation verify` refused the wheel .*gh exit 1/,
  );
  assert.deepEqual(fake.calls, [`fetch ${GENERATOR_WHEEL_URL}`, 'attest']);
});

test('lockGenerator refuses a compiled lock that records another wheel, before the dry runs or write', async () => {
  const other = 'f'.repeat(64);
  const fake = fakeSteps({ requirements: () => `${GENERATOR} \\\n    --hash=sha256:${other}\n` });
  await assert.rejects(
    lockGenerator(fake.steps, { cutoff: CUTOFF, approvedSha256: fake.digest }),
    (error: Error) => error.message.includes(other) && error.message.includes(fake.digest),
  );
  assert.deepEqual(fake.calls, [`fetch ${GENERATOR_WHEEL_URL}`, 'attest', 'uv --version', COMPILE]);
});

test('lockGenerator writes nothing when one dry run fails', async () => {
  const fake = fakeSteps({ failDryRun: '3.12 x86_64-pc-windows-msvc' });
  await assert.rejects(
    lockGenerator(fake.steps, { cutoff: CUTOFF, approvedSha256: fake.digest }),
    /does not install without a build on CPython 3\.12 for x86_64-pc-windows-msvc \(uv exit 1\), so it was not written\.\nno wheel/,
  );
  assert.equal(fake.calls.at(-1), 'dry run 3.12 x86_64-pc-windows-msvc');
  assert.ok(!fake.calls.includes('write'));
});

// pip and uv end a line at a bare CR, so what follows the CR is an entry of its own and
// not marker text. Found by codex: a false marker hides a second generator entry.
test('a generator entry after a bare CR is rejected', () => {
  const hidden = [
    `requests==2.34.2 ; python_version == "0"\r${GENERATOR} --hash=sha256:${OTHER} \\`,
    `    --hash=sha256:${'a'.repeat(64)}`,
    `${GENERATOR} \\`,
    `    --hash=sha256:${ATTESTED}`,
    '',
  ].join('\n');
  assert.throws(() => assertGeneratorLocked(hidden, GENERATOR, ATTESTED), /Line 1, column 41 of the lock has U\+000D\./);
});
