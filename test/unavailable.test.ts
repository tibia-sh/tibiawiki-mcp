import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

/**
 * Runs `body` against a server whose index path does not exist, then releases both
 * the client and the scratch directory.
 *
 * The directory's `finally` opens immediately after `mkdtempSync`, so it also covers
 * the connect: a failed spawn or a rejected handshake is the one path that would
 * otherwise still leak, and it is the path least likely to be noticed. The client is
 * released by the inner `finally`, which completes first, so the server is asked to
 * stop before its database path is removed rather than after. Nesting - rather than
 * one block doing both - is what keeps a `close()` that rejects from stranding the
 * directory, which is the whole failure this change exists to end.
 *
 * Unlike the scratch directories elsewhere in the suite, these cannot wait for an
 * end-of-file hook: three live subprocesses would outlive the tests that opened them.
 * The pairing itself is the one `scripts/decode-spell-areas.ts` uses.
 */
async function withMissingIndex(body: (client: Client) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'twmcp-none-'));
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['dist/index.js', 'serve'],
      env: { ...process.env, TIBIAWIKI_MCP_DB: join(dir, 'nope.db') } as Record<string, string>,
      cwd: process.cwd(),
    });
    const client = new Client({ name: 'unavailable-probe', version: '1.0.0' });
    await client.connect(transport);
    try {
      await body(client);
    } finally {
      await client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the server still connects when the index is missing', () => withMissingIndex(async (client) => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, TOOL_NAMES.length, 'the full tool surface must still be advertised');
}));

test('its instructions explain the missing index', () => withMissingIndex(async (client) => {
  assert.match(String(client.getInstructions()), /index unavailable/i);
}));

test('every tool answers with an actionable error instead of vanishing', () => withMissingIndex(async (client) => {
  for (const name of TOOL_NAMES) {
    const res = await client.callTool({ name, arguments: {} });
    assert.equal(res.isError, true, `${name} should report an error`);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    assert.match(text, /build-index/, `${name} should name the fix`);
  }
}));
