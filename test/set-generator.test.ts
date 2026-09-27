import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideGenerator, setGenerator } from '../scripts/set-generator.ts';
import { generatorWheelUrl } from '../src/indexer/generator-release.ts';
import { tempDirs } from './harness.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const BUILD_INDEX = readFileSync(join(root, 'src/indexer/build-index.ts'), 'utf8');
const SHA = 'c0bbb67c7ffe31f2a6d8ad6f9338683e52c6f526c4ecceaf306ddbb792395d4a';
const scratch = tempDirs('twmcp-set-generator-');

const versionLine = (version: string) => `export const GENERATOR_VERSION = '${version}';`;
const shaLine = (sha: string) => `export const GENERATOR_SHA256 = '${sha}';`;

test('setGenerator replaces the version and sha256 constants of build-index.ts, and nothing else', () => {
  const before = BUILD_INDEX.split('\n');
  const after = setGenerator(BUILD_INDEX, '9.0.0+tibiash.3', SHA).split('\n');
  assert.equal(after.length, before.length);
  const changed = before.flatMap((line, index) => (line === after[index] ? [] : [[line, after[index]]]));
  assert.deepEqual(changed, [
    [before.find((line) => line.startsWith('export const GENERATOR_VERSION = ')), versionLine('9.0.0+tibiash.3')],
    [before.find((line) => line.startsWith('export const GENERATOR_SHA256 = ')), shaLine(SHA)],
  ]);
});

test('setGenerator refuses a version or sha256 that is not whole, and a source without exactly one of each line', () => {
  const refused: Array<[string, () => string, RegExp]> = [
    ['a version with a command after it', () => setGenerator(BUILD_INDEX, '9.0.0+tibiash.3; x', SHA), /not a generator version/],
    ['a version with a trailing newline', () => setGenerator(BUILD_INDEX, '9.0.0+tibiash.3\n', SHA), /not a generator version/],
    ['a version without the tibiash release', () => setGenerator(BUILD_INDEX, '9.0.0', SHA), /not a generator version/],
    ['a 63-character sha256', () => setGenerator(BUILD_INDEX, '9.0.0+tibiash.3', SHA.slice(1)), /not a sha256/],
    ['a sha256 with a trailing newline', () => setGenerator(BUILD_INDEX, '9.0.0+tibiash.3', `${SHA}\n`), /not a sha256/],
    ['an uppercase sha256', () => setGenerator(BUILD_INDEX, '9.0.0+tibiash.3', SHA.toUpperCase()), /not a sha256/],
    [
      'a source with two GENERATOR_VERSION lines',
      () => setGenerator(`${BUILD_INDEX}${versionLine('9.0.0+tibiash.1')}\n`, '9.0.0+tibiash.3', SHA),
      /GENERATOR_VERSION .*2 times/,
    ],
    [
      'a source without a GENERATOR_SHA256 line',
      () => setGenerator(BUILD_INDEX.replace('export const GENERATOR_SHA256 = ', 'const GENERATOR_SHA256 = '), '9.0.0+tibiash.3', SHA),
      /GENERATOR_SHA256 .*0 times/,
    ],
  ];
  for (const [what, call, error] of refused) {
    assert.throws(call, error, `${what} is not refused`);
  }
});

const pr = (version: string, number: number, autoMerge = true) => ({ version, number, autoMerge });

test('decideGenerator does nothing for the pinned version, and refuses one below it', () => {
  assert.deepEqual(decideGenerator('9.0.0+tibiash.2', '9.0.0+tibiash.2', []), { action: 'noop', supersede: [] });
  assert.deepEqual(decideGenerator('9.0.0+tibiash.3', '9.0.0+tibiash.2', []), { action: 'refuse', supersede: [] });
  // A newer pin landed: the request is below it.
  assert.deepEqual(decideGenerator('9.0.0+tibiash.4', '9.0.0+tibiash.3', [pr('9.0.0+tibiash.3', 7)]), { action: 'refuse', supersede: [] });
});

test('decideGenerator orders versions by base semver as numbers, then by the tibiash release', () => {
  assert.equal(decideGenerator('9.0.0+tibiash.9', '9.0.0+tibiash.10', []).action, 'propose');
  assert.equal(decideGenerator('9.0.0+tibiash.9', '9.1.0+tibiash.1', []).action, 'propose');
  assert.equal(decideGenerator('9.10.0+tibiash.1', '9.9.0+tibiash.5', []).action, 'refuse');
  assert.equal(decideGenerator('9.0.0+tibiash.2', '10.0.0+tibiash.1', []).action, 'propose');
  assert.equal(decideGenerator('9.0.1+tibiash.1', '9.0.0+tibiash.99999999999999999999', []).action, 'refuse');
});

test('decideGenerator proposes a newer version, superseding the open PRs below it', () => {
  assert.deepEqual(decideGenerator('9.0.0+tibiash.2', '9.0.0+tibiash.3', []), { action: 'propose', supersede: [] });
  // Two in flight: an open PR for tibiash.3 when tibiash.4 is requested.
  assert.deepEqual(
    decideGenerator('9.0.0+tibiash.2', '9.0.0+tibiash.4', [pr('9.0.0+tibiash.3', 12)]),
    { action: 'propose', supersede: [12] },
  );
  // A PR left for a version the pin already passed is superseded too.
  assert.deepEqual(
    decideGenerator('9.0.0+tibiash.3', '9.0.0+tibiash.4', [pr('9.0.0+tibiash.2', 5), pr('9.0.0+tibiash.3', 9)]),
    { action: 'propose', supersede: [5, 9] },
  );
});

test('decideGenerator re-arms an open PR for the version whose auto-merge is off, and leaves one that has it on', () => {
  // Interrupted after the PR was opened, before its auto-merge was turned on.
  assert.deepEqual(
    decideGenerator('9.0.0+tibiash.2', '9.0.0+tibiash.3', [pr('9.0.0+tibiash.3', 14, false)]),
    { action: 'rearm', supersede: [], pr: 14 },
  );
  assert.deepEqual(
    decideGenerator('9.0.0+tibiash.2', '9.0.0+tibiash.4', [pr('9.0.0+tibiash.3', 12), pr('9.0.0+tibiash.4', 14, false)]),
    { action: 'rearm', supersede: [12], pr: 14 },
  );
  assert.deepEqual(
    decideGenerator('9.0.0+tibiash.2', '9.0.0+tibiash.3', [pr('9.0.0+tibiash.3', 14)]),
    { action: 'noop', supersede: [] },
  );
});

test('decideGenerator does nothing when an open PR is for a newer version than the one requested', () => {
  // Reverse order: tibiash.4's PR is open when tibiash.3's request arrives.
  assert.deepEqual(
    decideGenerator('9.0.0+tibiash.2', '9.0.0+tibiash.3', [pr('9.0.0+tibiash.4', 20, false)]),
    { action: 'noop', supersede: [] },
  );
});

test('decideGenerator refuses what it cannot read, before it decides', () => {
  const refused: Array<[string, () => unknown, RegExp]> = [
    ['a pinned version that is not whole', () => decideGenerator('9.0.0', '9.0.0+tibiash.3', []), /not a generator version/],
    ['a requested version with a trailing newline', () => decideGenerator('9.0.0+tibiash.2', '9.0.0+tibiash.3\n', []), /not a generator version/],
    ['a PR version that is not whole', () => decideGenerator('9.0.0+tibiash.2', '9.0.0+tibiash.3', [pr('main', 3)]), /not a generator version/],
    ['a PR number that is not a positive whole number', () => decideGenerator('9.0.0+tibiash.2', '9.0.0+tibiash.3', [pr('9.0.0+tibiash.3', 1.5)]), /not a pull request number/],
    [
      'two open PRs for one version',
      () => decideGenerator('9.0.0+tibiash.2', '9.0.0+tibiash.4', [pr('9.0.0+tibiash.3', 3), pr('9.0.0+tibiash.3', 4)]),
      /two open pull requests.*9\.0\.0\+tibiash\.3/,
    ],
  ];
  for (const [what, call, error] of refused) {
    assert.throws(call, error, `${what} is not refused`);
  }
});

/**
 * A copy of the CLI and the files it reads, in the repository's layout, so a run never touches
 * this checkout. Its build-index.ts pins `pinned`.
 */
const cliCopy = (pinned = '9.0.0+tibiash.2'): { dir: string; buildIndex: string } => {
  const dir = scratch();
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'src/indexer'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  copyFileSync(join(root, 'scripts/set-generator.ts'), join(dir, 'scripts/set-generator.ts'));
  copyFileSync(join(root, 'src/indexer/generator-release.ts'), join(dir, 'src/indexer/generator-release.ts'));
  const buildIndex = join(dir, 'src/indexer/build-index.ts');
  writeFileSync(buildIndex, setGenerator(BUILD_INDEX, pinned, 'a'.repeat(64)));
  return { dir, buildIndex };
};

/**
 * A module the CLI runs with `--import`, whose fetch answers the wheel download with `status`
 * and `body`, and records each URL it was asked for in the file `record`. No request leaves the
 * machine.
 */
const stubFetch = (record: string, status: number, body: string): string =>
  `data:text/javascript,${encodeURIComponent(`
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url) => {
      appendFileSync(${JSON.stringify(record)}, String(url) + '\\n');
      return new Response(${JSON.stringify(body)}, { status: ${status} });
    };
  `)}`;

const runSet = (dir: string, version: string, status: number, body: string) => {
  const record = join(dir, 'fetched');
  writeFileSync(record, '');
  const run = spawnSync(
    process.execPath,
    ['--import', stubFetch(record, status, body), join(dir, 'scripts/set-generator.ts'), 'set', version],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' }, timeout: 30_000 },
  );
  return { ...run, fetched: readFileSync(record, 'utf8').split('\n').filter((line) => line !== '') };
};

test('the set CLI downloads the wheel of the version, then writes its sha256 into build-index.ts', () => {
  const { dir, buildIndex } = cliCopy();
  const before = readFileSync(buildIndex, 'utf8');
  const run = runSet(dir, '9.0.0+tibiash.3', 200, 'wheel bytes');
  const sha = createHash('sha256').update('wheel bytes').digest('hex');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.fetched, [generatorWheelUrl('9.0.0+tibiash.3')]);
  assert.equal(run.stdout, `${sha}\n`);
  assert.equal(readFileSync(buildIndex, 'utf8'), setGenerator(before, '9.0.0+tibiash.3', sha));
});

test('the set CLI leaves build-index.ts untouched when the download fails, or the version is not whole', () => {
  const { dir, buildIndex } = cliCopy();
  const before = readFileSync(buildIndex, 'utf8');
  const failed = runSet(dir, '9.0.0+tibiash.3', 404, 'Not Found');
  assert.notEqual(failed.status, 0, 'a failed download passes');
  assert.match(failed.stderr, /HTTP 404/);
  assert.deepEqual(failed.fetched, [generatorWheelUrl('9.0.0+tibiash.3')]);
  assert.equal(failed.stdout, '');
  const invalid = runSet(dir, '9.0.0+tibiash.3; x', 200, 'wheel bytes');
  assert.notEqual(invalid.status, 0, 'a version that is not whole passes');
  assert.deepEqual(invalid.fetched, [], 'a version that is not whole is downloaded');
  assert.equal(readFileSync(buildIndex, 'utf8'), before);
});

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();

/**
 * A stand-in gh that answers the open pull request read with `lines`, and fails on any other
 * command, or without GH_TOKEN and GH_REPO.
 */
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_RUN/gh-calls"
if [ -z "$GH_TOKEN" ] || [ -z "$GH_REPO" ]; then echo "fake gh: no GH_TOKEN or GH_REPO" >&2; exit 2; fi
if [ "$1 $2 $3" != "api --paginate repos/{owner}/{repo}/pulls?state=open&base=main&per_page=100" ] || [ "$4" != --jq ]; then
  echo "fake gh: unsupported command: $*" >&2
  exit 2
fi
cat "$GH_RUN/pulls"
`;

/** A line of the PR read as the stand-in gh prints it. */
const openPr = (ref: string, number: number, autoMerge: boolean, headRepo = 'tibia-sh/tibiawiki-mcp') =>
  JSON.stringify({ number, ref, headRepo, baseRepo: 'tibia-sh/tibiawiki-mcp', autoMerge });

test('the decide CLI reads the pin from origin/main after a fetch, and only this repository\'s generator PRs', () => {
  // origin's main pins tibiash.3, while the checkout the run started from still pins tibiash.2.
  const origin = scratch();
  git(origin, ['init', '--quiet', '--bare', '--initial-branch=main']);
  const { dir, buildIndex } = cliCopy('9.0.0+tibiash.2');
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '--message', 'checkout']);
  git(dir, ['remote', 'add', 'origin', origin]);
  writeFileSync(buildIndex, setGenerator(readFileSync(buildIndex, 'utf8'), '9.0.0+tibiash.3', 'b'.repeat(64)));
  git(dir, ['commit', '--quiet', '--all', '--message', 'newer pin']);
  git(dir, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  git(dir, ['reset', '--quiet', '--hard', 'HEAD~1']);
  const fakes = scratch();
  writeFileSync(join(fakes, 'gh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(dir, 'pulls'), [
    openPr('generator/9.0.0+tibiash.4', 21, true),
    // A fork's branch of the same name, a branch that is not a generator version, and a branch
    // outside generator/ do not count.
    openPr('generator/9.0.0+tibiash.9', 22, false, 'someone/tibiawiki-mcp'),
    openPr('generator/notes', 23, false),
    openPr('release-please--branches--main', 24, false),
    '',
  ].join('\n'));
  const decide = (version: string) => {
    const run = spawnSync(process.execPath, [join(dir, 'scripts/set-generator.ts'), 'decide', version], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${fakes}:${process.env['PATH'] ?? ''}`,
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GH_TOKEN: 'fake-token',
        GH_REPO: 'tibia-sh/tibiawiki-mcp',
        GH_RUN: dir,
      },
      timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout) as unknown;
  };
  // tibiash.3 is main's pin, so nothing is done, although the checkout pins tibiash.2.
  assert.deepEqual(decide('9.0.0+tibiash.3'), { action: 'noop', supersede: [] });
  assert.deepEqual(decide('9.0.0+tibiash.5'), { action: 'propose', supersede: [21] });
  assert.equal(readFileSync(buildIndex, 'utf8').includes(versionLine('9.0.0+tibiash.2')), true, 'decide wrote the checkout');
});
