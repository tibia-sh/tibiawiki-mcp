import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempDirs } from './harness.ts';

const scratch = tempDirs('twmcp-bi-cli-');

/**
 * A failed `build-index` used to end in an uncaught rejection, so the user read a stack
 * trace with the reason somewhere inside it. Now it reports failures the way
 * `index-digest` does: one `tibiawiki-mcp: ` diagnostic on stderr and exit code 1.
 *
 * The built binary runs with a PATH of one empty directory, so `uv` cannot start and the
 * build fails before anything reaches the network. `TIBIAWIKI_MCP_DB`, `XDG_CACHE_HOME`
 * and `TMPDIR` point into scratch directories, so the run never touches a real index and
 * the test sees what the failure leaves behind.
 */
test('build-index without uv exits 1 with a prefixed diagnostic, no stack trace and nothing left behind', () => {
  const indexDir = scratch();
  const tmpDir = scratch();
  const run = spawnSync(process.execPath, ['dist/index.js', 'build-index'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: scratch(),
      TIBIAWIKI_MCP_DB: join(indexDir, 'tibiawiki.db'),
      XDG_CACHE_HOME: scratch(),
      TMPDIR: tmpDir,
      // Cleared, because an inherited option can hide the failure this test looks for.
      // --stack-trace-limit=0 prints a stack trace with no `at` lines, and
      // --unhandled-rejections=warn turns an escaped rejection into a warning, which
      // NODE_NO_WARNINGS below silences.
      NODE_OPTIONS: '',
      // Node 22, which engines allows, warns that node:sqlite is experimental before this
      // CLI writes anything, and the warning would sit ahead of the diagnostic.
      NODE_NO_WARNINGS: '1',
    },
  });

  assert.equal(run.status, 1, run.stderr);
  assert.ok(
    run.stderr.startsWith('tibiawiki-mcp: Could not install the generator environment'),
    `stderr was: ${run.stderr}`,
  );
  assert.ok(run.stderr.includes('Is `uv` installed?'), `stderr was: ${run.stderr}`);
  // A command that never started has no exit status, so the diagnostic names the spawn error.
  assert.ok(run.stderr.includes('(`uv venv` could not start: ENOENT)'), `stderr was: ${run.stderr}`);
  assert.ok(!run.stderr.includes('exit null'), `stderr was: ${run.stderr}`);
  assert.deepEqual(
    run.stderr.split('\n').filter((line) => /^\s+at /.test(line)),
    [],
    `stderr carries a stack trace: ${run.stderr}`,
  );
  assert.deepEqual(readdirSync(indexDir), [], 'a failed build must leave no index and no .tibiawiki.db.*.tmp');
  assert.deepEqual(
    readdirSync(tmpDir).filter((name) => name.startsWith('tibiawiki-mcp-generator-')),
    [],
    'the generator environment must be removed',
  );
});
