import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FIXTURE } from './harness.ts';

/**
 * Protocol conformance against the REAL published binary over REAL stdio - the
 * transport an MCP host actually uses. The in-memory harness covers tool behaviour;
 * this covers the wiring the harness bypasses.
 */
async function connectStdio() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js', 'serve'],
    env: { ...process.env, TIBIAWIKI_MCP_DB: FIXTURE } as Record<string, string>,
    cwd: process.cwd(),
  });
  const client = new Client({ name: 'stdio-conformance', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

test('the built binary serves all five tools over stdio', async () => {
  const client = await connectStdio();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'tibia_find_creatures', 'tibia_find_items', 'tibia_get',
    'tibia_how_to_obtain', 'tibia_search',
  ]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} must be read-only`);
  }
  await client.close();
});

test('a real attribute query works end to end over stdio', async () => {
  const client = await connectStdio();
  const res = await client.callTool({
    name: 'tibia_find_creatures',
    arguments: { weak_to: ['fire'], limit: 3 },
  });
  const data = res.structuredContent as { results: Array<{ title: string }> };
  assert.ok(data.results.length > 0, 'the headline query must return data over stdio');
  await client.close();
});
