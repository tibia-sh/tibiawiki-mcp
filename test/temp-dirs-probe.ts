/**
 * The subject of test/temp-dirs.test.ts, which runs this file as a child process with
 * TMPDIR pointed at a sandbox and asserts the sandbox is empty afterwards.
 *
 * Deliberately not named `*.test.ts`: the suite's glob is `test/*.test.ts`, and this
 * file is meant to fail. Its second test throws on purpose, because the failure path
 * is the one that built the original pile - `pnpm test` stayed green throughout.
 */
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDirs } from './harness.ts';

// Two factories, as test/db.test.ts uses: each registers its own hook, and both must run.
const passing = tempDirs('twmcp-probe-pass-');
const failing = tempDirs('twmcp-probe-fail-');

test('a passing test writes into a scratch directory', () => {
  writeFileSync(join(passing(), 'scratch.db'), 'x');
});

test('a failing test writes into a scratch directory', () => {
  writeFileSync(join(failing(), 'scratch.db'), 'x');
  throw new Error('deliberate: cleanup has to survive a failing test');
});
