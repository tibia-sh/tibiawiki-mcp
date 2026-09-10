import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { TOOL_NAMES } from '../src/server.ts';

/**
 * Regression: the server used to exit(1) when the index was missing. An MCP host
 * showed only "CONNECTION_CLOSED" and the actionable message died on stderr - which
 * is exactly how this shipped broken into a real Claude Code registration.
 */
async function connectWithMissingIndex() {
  const absent = join(mkdtempSync(join(tmpdir(), 'twmcp-none-')), 'nope.db');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js', 'serve'],
    env: { ...process.env, TIBIAWIKI_MCP_DB: absent } as Record<string, string>,
    cwd: process.cwd(),
  });
  const client = new Client({ name: 'unavailable-probe', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

test('the server still connects when the index is missing', async () => {
  const client = await connectWithMissingIndex();
  const { tools } = await client.listTools();
  assert.equal(tools.length, TOOL_NAMES.length, 'the full tool surface must still be advertised');
  await client.close();
});

test('its instructions explain the missing index', async () => {
  const client = await connectWithMissingIndex();
  assert.match(String(client.getInstructions()), /index unavailable/i);
  await client.close();
});

test('every tool answers with an actionable error instead of vanishing', async () => {
  const client = await connectWithMissingIndex();
  for (const name of TOOL_NAMES) {
    const res = await client.callTool({ name, arguments: {} });
    assert.equal(res.isError, true, `${name} should report an error`);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    assert.match(text, /build-index/, `${name} should name the fix`);
  }
  await client.close();
});
