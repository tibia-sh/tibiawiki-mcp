import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { openDb } from '../src/db.ts';
import { createServer } from '../src/server.ts';
import { ENTITY_TYPES } from '../src/domain.ts';
import { FIXTURE } from './harness.ts';

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
  // Plugins install to different locations; a hardcoded path breaks every install
  // that is not this checkout.
  assert.ok(
    server.args.some((a: string) => a.includes('${CLAUDE_PLUGIN_ROOT}')),
    'server path must use ${CLAUDE_PLUGIN_ROOT}, never a hardcoded path',
  );
  assert.ok(!JSON.stringify(mcp).includes('/Users/'), 'no absolute developer paths');
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
  assert.ok(bytes < 30_000, `tools/list is ${bytes} bytes, over the 30,000 budget`);
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
