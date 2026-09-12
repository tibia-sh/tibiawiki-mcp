import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Durable guard against the leak returning. The suite once left 8,283 `twmcp-*`
 * directories - about 7 GB - in $TMPDIR, one per scratch database any test had ever
 * built. Nothing caught it, because a leaked directory breaks no assertion: `pnpm test`
 * was green the entire time the pile accumulated.
 *
 * Two halves, because the leak has two ways back. This one proves the mechanism in
 * `tempDirs` actually removes what it hands out; the one below proves new test files
 * keep using it.
 *
 * The probe has to run as a child process: cleanup happens in an `after` hook, so no
 * test inside a file can observe its own file's final state. Pointing the child's
 * TMPDIR at a sandbox is what makes the count exact - the runner executes sibling files
 * in parallel, and their scratch directories would otherwise land in the same shared
 * $TMPDIR and make this flaky.
 */
test('a test file removes every scratch directory it creates, even when a test fails', () => {
  const probe = fileURLToPath(new URL('./temp-dirs-probe.ts', import.meta.url));
  const sandbox = mkdtempSync(join(tmpdir(), 'twmcp-leakguard-'));
  try {
    // Node marks every test-file process with NODE_TEST_CONTEXT. Inherited, it makes the
    // child report results up to this runner and exit 0 regardless of its own failures,
    // which would quietly turn the status assertion below into a no-op.
    // Annotated: spreading process.env drops its index signature, so the delete below
    // would not typecheck against the inferred `{ TMPDIR: string }`.
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: sandbox };
    delete env['NODE_TEST_CONTEXT'];
    const run = spawnSync(process.execPath, ['--test', probe], { env, encoding: 'utf8' });

    // The probe fails on purpose. If it ever passes, it has stopped exercising the
    // failure path, and this would be asserting cleanup only for the easy case.
    assert.notEqual(run.status, 0,
      `the probe must fail to prove anything; it exited ${run.status}\n${run.stdout}${run.stderr}`);
    const leaked = readdirSync(sandbox).filter((name) => name.startsWith('twmcp-'));
    assert.deepEqual(leaked, [], `scratch directories outlived the probe: ${leaked.join(', ')}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

/**
 * All four original offenders were written the same way: a bare `mkdtempSync` and no
 * removal anywhere in the file. That is the shape this rejects. A file may own its own
 * cleanup - `unavailable.test.ts` must, since it holds a subprocess - so the rule is
 * pairing, not a list of blessed files: create a directory here and you remove one here,
 * or you call `tempDirs` from harness.ts and it removes them for you.
 */
test('no test file creates a temp directory without also removing one', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const unpaired = readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => {
      const src = readFileSync(join(dir, name), 'utf8');
      return src.includes('mkdtempSync') && !src.includes('rmSync');
    });
  assert.deepEqual(unpaired, [],
    `these create a temp directory and never remove it; use tempDirs() from harness.ts: ${unpaired.join(', ')}`);
});
