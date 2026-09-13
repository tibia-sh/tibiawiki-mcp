#!/usr/bin/env node
/**
 * Consumer smoke check: install the package the way a user would, and drive it.
 *
 *   pnpm smoke ./tibia.sh-tibiawiki-mcp-0.2.0.tgz   a local `npm pack` tarball, pre-publish
 *   pnpm smoke @tibia.sh/tibiawiki-mcp@0.2.0        the published artifact, post-publish
 *
 * Installs the package under test into a throwaway directory, spawns the INSTALLED
 * binary over real stdio twice, and drives it with a real MCP client:
 *
 *   - with no index it can read, a tool call errors and names build-index;
 *   - with only its packaged index to read, a real query answers from that index.
 *
 * Why each choice, since every one of them is a trap this check hit during review:
 *
 *   - It spawns `node_modules/.bin/tibiawiki-mcp`, not `dist/index.js`. The installed
 *     layout is the thing being tested; a path into the source tree proves nothing
 *     about the tarball.
 *   - Neither run lets the machine's own index decide the outcome. With TIBIAWIKI_MCP_DB
 *     unset, resolveDbPath prefers a built index at
 *     ${XDG_CACHE_HOME:-$HOME/.cache}/tibiawiki-mcp/tibiawiki.db over the packaged one,
 *     so any machine that has ever built an index would answer from it - or fail on it,
 *     when it is stale - while proving nothing about the package. A clean npm cache is
 *     not a clean XDG cache. So the missing-index run sets TIBIAWIKI_MCP_DB to a path
 *     that does NOT exist, and the packaged-index run unsets it and points XDG_CACHE_HOME
 *     at an empty directory.
 *   - The packaged-index run checks the answer's indexGeneratedAt against the
 *     generate_time of the index in the installed @tibia.sh/tibiawiki-data, read through
 *     that package's DB_PATH. An answer from any other index fails.
 *   - It CALLS a tool, not just tools/list. The unavailable-index server still
 *     advertises the full tool surface, so listing alone cannot establish the error
 *     behaviour. test/unavailable.test.ts calls tools for exactly this reason.
 *   - It installs @modelcontextprotocol/client explicitly: it is a devDependency of the
 *     server, so it is NOT available transitively from the installed package.
 *   - It strips the lowercase npm_* keys from the child environment. A package manager
 *     or npx running a script can export its own config that way, and npm rejects some
 *     of it outright (EALLOWSCRIPTS) while silently applying the rest to an install meant
 *     to look like a stranger's.
 *     Case is load-bearing: npm reads NPM_CONFIG_* too, and those are the operator's own
 *     registry, proxy and CA settings, which a real consumer would have as well.
 *   - Every scratch path either run needs lives inside the one scratch directory, which
 *     is removed on every exit path: pass, fail, or interrupted.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TOOL_NAMES = [
  'tibia_find_creatures', 'tibia_find_items', 'tibia_get',
  'tibia_how_to_obtain', 'tibia_search',
];
const TIMEOUT_MS = 120_000;

const spec = process.argv[2];
if (!spec) {
  process.stderr.write('usage: node scripts/smoke.mjs <tarball-path|package@version>\n');
  process.exit(2);
}
// A local tarball must be resolved before we chdir into the scratch directory.
const target = spec.endsWith('.tgz') ? resolve(spec) : spec;

const dir = mkdtempSync(join(tmpdir(), 'twmcp-smoke-'));
let failed = false;

const clean = () => rmSync(dir, { recursive: true, force: true });
// The try/finally below covers pass and fail. An interrupted run needs these as well, or
// the scratch install is left behind.
for (const [signal, code] of Object.entries({ SIGINT: 130, SIGTERM: 143 })) {
  process.on(signal, () => {
    clean();
    process.exit(code);
  });
}

// A consumer's shell carries none of this repo's package-manager config.
const CONSUMER_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('npm_')),
);

/** @type {(cmd: string, args: string[]) => string} */
const run = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: dir, env: CONSUMER_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * npm's stderr is the only useful diagnostic for a failed install; `message` alone says
 * just "exited 1". The probe's reasons stream straight through, so its message is enough.
 */
/** @type {(error: unknown) => string} */
const detail = (error) => {
  if (!(error instanceof Error)) return String(error);
  const { stderr } = /** @type {Error & { stderr?: string | null }} */ (error);
  return stderr || error.message;
};

try {
  process.stderr.write(`scratch: ${dir}\ninstalling ${target}\n`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true }, null, 2));
  run('npm', ['install', '--no-audit', '--no-fund', target, '@modelcontextprotocol/client@2.0.0']);

  // Driven from a file inside the scratch dir so its imports resolve against the
  // installed node_modules rather than this script's location.
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, `
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// The scratch directory. Every path below stays inside it, so its removal covers them.
const cwd = process.cwd();

/** Spawns the installed binary with env, runs body against it, and always disconnects. */
async function withServer(env, body) {
  const transport = new StdioClientTransport({
    command: join(cwd, 'node_modules', '.bin', 'tibiawiki-mcp'),
    args: ['serve'],
    env,
    cwd,
  });
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(transport);
  try {
    await body(client);
  } finally {
    await client.close();
  }
}

const textOf = (res) => (res.content ?? []).map((part) => part.text ?? '').join(' ');

// Missing index: a path that is never created.
await withServer({ ...process.env, TIBIAWIKI_MCP_DB: join(cwd, 'no-index', 'nope.db') }, async (client) => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ${JSON.stringify([...TOOL_NAMES].sort())}, 'tool surface');
  console.log('  initialize + tools/list: ' + names.length + ' tools');

  // The assertion that listing cannot make.
  const res = await client.callTool({ name: 'tibia_get', arguments: {} });
  assert.equal(res.isError, true, 'a tool call against a missing index must error');
  assert.match(textOf(res), /build-index/, 'the error must name the fix');
  console.log('  missing index: the tool call errors and names build-index');
});

// Packaged index: no override and an empty cache, so the packaged index is all there is.
const emptyCache = join(cwd, 'empty-cache');
mkdirSync(emptyCache);
const packagedEnv = { ...process.env, XDG_CACHE_HOME: emptyCache };
delete packagedEnv.TIBIAWIKI_MCP_DB;
await withServer(packagedEnv, async (client) => {
  const res = await client.callTool({
    name: 'tibia_get', arguments: { name: 'Dragon', type: 'creature' },
  });
  assert.notEqual(res.isError, true, 'the packaged index must answer a real query: ' + textOf(res));
  const dragon = res.structuredContent;
  assert.equal(dragon.title, 'Dragon', 'the query must return real data');

  // The data package the installed server depends on, resolved from the server's own
  // directory, as the server's locator resolves it.
  const fromServer = createRequire(join(cwd, 'node_modules', '@tibia.sh', 'tibiawiki-mcp', 'package.json'));
  const { DB_PATH } = await import(pathToFileURL(fromServer.resolve('@tibia.sh/tibiawiki-data')).href);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const row = db.prepare("select value from database_info where key = 'generate_time'").get();
  db.close();
  assert.equal(dragon.source.indexGeneratedAt, row.value,
    'the answer came from an index other than ' + DB_PATH);
  console.log('  packaged index: tibia_get answers from ' + DB_PATH);
});
`);

  // Streamed rather than captured, so the first run's lines stay visible when the second fails.
  execFileSync(process.execPath, ['probe.mjs'], {
    cwd: dir, env: CONSUMER_ENV, timeout: TIMEOUT_MS, stdio: ['ignore', 'inherit', 'inherit'],
  });
  process.stdout.write(`\nPASS  ${target}\n`);
} catch (error) {
  failed = true;
  process.stderr.write(`\nFAIL  ${target}\n${detail(error)}\n`);
} finally {
  // Cleanup on pass or fail. The signal handlers above cover an interrupted run.
  clean();
}
process.exit(failed ? 1 : 0);
