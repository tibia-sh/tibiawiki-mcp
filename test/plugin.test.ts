import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { openDb } from '../src/db.ts';
import { createServer } from '../src/server.ts';
import { ENTITY_TYPES } from '../src/domain.ts';
import { FIXTURE, TOOLS_LIST_BUDGET } from './harness.ts';

const root = new URL('..', import.meta.url).pathname;

test('the skill has the frontmatter Claude Code requires', () => {
  const skill = readFileSync(`${root}skills/tibiawiki/SKILL.md`, 'utf8');
  const match = /^---\n([\s\S]*?)\n---/.exec(skill);
  assert.ok(match, 'SKILL.md must open with YAML frontmatter');
  const front = match[1]!;
  assert.match(front, /^name:\s*\S+/m, 'frontmatter needs a name');
  assert.match(front, /^description:\s*\S+/m, 'frontmatter needs a description');
  // The description is the only always-on cost, and it is what makes the skill fire.
  const description = /^description:\s*(.+)$/m.exec(front)![1]!;
  assert.ok(description.length > 60, 'description too thin to trigger reliably');
  assert.match(description, /tibia/i);
});

test('the plugin manifest and MCP config are well formed', () => {
  const manifest = JSON.parse(readFileSync(`${root}.claude-plugin/plugin.json`, 'utf8'));
  assert.match(manifest.name, /^[a-z0-9-]+$/, 'plugin name must be kebab-case');
  const mcp = JSON.parse(readFileSync(`${root}.mcp.json`, 'utf8'));
  const server = mcp.mcpServers.tibiawiki;
  assert.ok(server, '.mcp.json must define the tibiawiki server');
  // The plugin runs the published package through npx, so an install needs no checkout,
  // no build and no pnpm install.
  assert.equal(server.command, 'npx', 'the server must start through npx');
  // Asked for @tibia.sh/tibiawiki-mcp@<version> by name, npx takes a checkout of this repo
  // for the installed package and runs a bin nothing linked, so the server never starts in
  // one. Through an alias, npx fetches the published package wherever it runs.
  const spec = server.args[1];
  assert.ok(
    typeof spec === 'string' && spec.startsWith('tibiawiki-mcp@npm:@tibia.sh/tibiawiki-mcp@'),
    'the server package must be requested through the tibiawiki-mcp alias',
  );
  // Offline, npm retries its registry check for 70 s before it serves a warm cache, which is
  // past the 30 s Claude Code gives an MCP server to start.
  assert.equal(server.env?.npm_config_fetch_retries, '0', 'npx must not retry the registry');
  // A range would move users who never updated the plugin onto a release nobody shipped
  // it with, a new major included.
  const command = [server.command, ...server.args].join(' ');
  assert.doesNotMatch(command, /@tibia\.sh\/tibiawiki-mcp@[\^~]/, 'the server package must not be pinned to a range');
  const pin = /@tibia\.sh\/tibiawiki-mcp@(\d+\.\d+\.\d+)(?!\S)/.exec(command);
  assert.ok(pin, 'the server package must be pinned to an exact x.y.z');
  // A release PR bumps package.json's version, so this fails on one whose pin did not move.
  const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
  assert.equal(pin[1], version, 'the pinned version must be the one package.json carries');
  assert.ok(!JSON.stringify(mcp).includes('/Users/'), 'no absolute developer paths');
});

test('the marketplace lists this plugin and leaves its version to plugin.json', () => {
  const marketplace = JSON.parse(readFileSync(`${root}.claude-plugin/marketplace.json`, 'utf8'));
  const manifest = JSON.parse(readFileSync(`${root}.claude-plugin/plugin.json`, 'utf8'));
  assert.match(marketplace.owner?.name ?? '', /\S/, 'the marketplace needs an owner name');
  const entry = marketplace.plugins?.find((plugin: { name: unknown }) => plugin.name === manifest.name);
  assert.ok(entry, `the marketplace must list the plugin under plugin.json's name, ${manifest.name}`);
  // The plugin is the repository root, where plugin.json, .mcp.json and the skill live.
  assert.equal(entry.source, './', 'the plugin source must be the repository root');
  // Plugin listings show the entry's description over plugin.json's, before and after
  // install, so a description changed in plugin.json alone would not show there.
  assert.equal(entry.description, manifest.description, "the entry description must be plugin.json's");
  // release-please bumps the version in plugin.json only. Claude Code uses that one without a
  // warning when the entry sets its own, and `claude plugin validate` passes both, so a version
  // here could only go stale.
  assert.ok(!Object.hasOwn(entry, 'version'), 'the entry must not carry a version');
});

test('tools/list stays within the stated byte budget', async () => {
  const handle = openDb(FIXTURE);
  const server = createServer(handle);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'budget', version: '1.0.0' });
  await client.connect(ct);
  const { tools } = await client.listTools();
  const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  await client.close();
  await server.close();
  handle.close();
  assert.ok(bytes < TOOLS_LIST_BUDGET, `tools/list is ${bytes} bytes, over the ${TOOLS_LIST_BUDGET} budget`);
});

// A description that still named five types would send a client looking for houses
// or imbuements somewhere else entirely.
test('the lookup tools advertise every entity type they accept', async () => {
  const handle = openDb(FIXTURE);
  const server = createServer(handle);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'desc', version: '1.0.0' });
  await client.connect(ct);
  const { tools } = await client.listTools();
  for (const name of ['tibia_get', 'tibia_search']) {
    const tool = tools.find((t) => t.name === name)!;
    const description = tool.description!;
    const missing = ENTITY_TYPES.filter((t) => !description.toLowerCase().includes(t));
    assert.deepEqual(missing, [], `${name} does not mention: ${missing.join(', ')}`);
    // The input schema ships to the model too. A `.describe()` saying "all five"
    // passed this test while the description was correct, because only the
    // description was read.
    const schema = JSON.stringify(tool.inputSchema ?? {}).toLowerCase();
    assert.ok(!/all five|five kinds|five types/.test(schema),
      `${name} inputSchema still claims five entity types`);
  }
  await client.close();
  await server.close();
  handle.close();
});
