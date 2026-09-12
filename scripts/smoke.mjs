#!/usr/bin/env node
/**
 * Consumer smoke check: install the package the way a user would, and drive it.
 *
 *   pnpm smoke ./tibia.sh-tibiawiki-mcp-0.1.0.tgz   a local `npm pack` tarball, pre-publish
 *   pnpm smoke @tibia.sh/tibiawiki-mcp@0.1.0        the published artifact, post-publish
 *
 * Installs the package under test into a throwaway directory, spawns the INSTALLED
 * binary over real stdio, and drives it with a real MCP client.
 *
 * Why each choice, since every one of them is a trap this check hit during review:
 *
 *   - It spawns `node_modules/.bin/tibiawiki-mcp`, not `dist/index.js`. The installed
 *     layout is the thing being tested; a path into the source tree proves nothing
 *     about the tarball.
 *   - It sets TIBIAWIKI_MCP_DB to a path that does NOT exist, rather than omitting it.
 *     With the variable unset, resolveDbPath falls back to
 *     ${XDG_CACHE_HOME:-$HOME/.cache}/tibiawiki-mcp/tibiawiki.db - and any machine that
 *     has ever built an index passes on its own cache while proving nothing about the
 *     package. A clean npm cache is not a clean XDG cache.
 *   - It CALLS a tool, not just tools/list. The unavailable-index server still
 *     advertises the full tool surface, so listing alone cannot establish the error
 *     behaviour. test/unavailable.test.ts calls tools for exactly this reason.
 *   - It installs @modelcontextprotocol/client explicitly: it is a devDependency of the
 *     server, so it is NOT available transitively from the installed package.
 *   - It strips the lowercase npm_* keys from the child environment. A package manager
 *     running a script exports its own config that way, and npm rejects some of it
 *     outright (EALLOWSCRIPTS, from this repo's allowBuilds) while silently applying the
 *     rest - minimumReleaseAge and all - to an install meant to look like a stranger's.
 *     Case is load-bearing: npm reads NPM_CONFIG_* too, and those are the operator's own
 *     registry, proxy and CA settings, which a real consumer would have as well.
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

// A consumer's shell carries none of this repo's package-manager config.
const CONSUMER_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('npm_')),
);

/** @type {(cmd: string, args: string[]) => string} */
const run = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: dir, env: CONSUMER_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });

/** The child's stderr is the only useful diagnostic; `message` alone says just "exited 1". */
/** @type {(error: unknown) => string} */
const detail = (error) => {
  if (!(error instanceof Error)) return String(error);
  const { stderr } = /** @type {Error & { stderr?: string }} */ (error);
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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const absent = join(mkdtempSync(join(tmpdir(), 'twmcp-none-')), 'nope.db');
const transport = new StdioClientTransport({
  command: join(process.cwd(), 'node_modules', '.bin', 'tibiawiki-mcp'),
  args: ['serve'],
  env: { ...process.env, TIBIAWIKI_MCP_DB: absent },
  cwd: process.cwd(),
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, ${JSON.stringify([...TOOL_NAMES].sort())}, 'tool surface');
console.log('  initialize + tools/list: ' + names.length + ' tools');

// The assertion that listing cannot make.
const res = await client.callTool({ name: 'tibia_get', arguments: {} });
assert.equal(res.isError, true, 'a tool call against a missing index must error');
const text = res.content[0].text;
assert.match(text, /build-index/, 'the error must name the fix');
console.log('  tool call errors and names build-index');

await client.close();
`);

  const out = execFileSync(process.execPath, ['probe.mjs'], {
    cwd: dir, env: CONSUMER_ENV, encoding: 'utf8', timeout: TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(out);
  process.stdout.write(`\nPASS  ${target}\n`);
} catch (error) {
  failed = true;
  process.stderr.write(`\nFAIL  ${target}\n${detail(error)}\n`);
} finally {
  // Cleanup on every exit path, pass or fail.
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
