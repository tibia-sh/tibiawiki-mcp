import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';

type SearchOut = {
  results: Array<{ title: string; type: string }>;
  nextCursor?: string;
  indexGeneratedAt: string;
};

test('tibia_search finds a creature by partial name', async () => {
  const h = await connect();
  const res = await h.client.callTool({ name: 'tibia_search', arguments: { query: 'drag' } });
  const data = res.structuredContent as SearchOut;
  assert.ok(data.results.length > 0, 'expected matches');
  assert.ok(data.results.some((r) => r.title === 'Dragon'), 'Dragon should match "drag"');
  assert.ok(data.results.every((r) => typeof r.type === 'string'));
  await h.close();
});

test('tibia_search restricted by type returns only that type, non-empty', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_search', arguments: { query: 'a', types: ['item'] },
  });
  const data = res.structuredContent as SearchOut;
  assert.ok(data.results.length > 0, 'expected item matches');
  assert.ok(data.results.every((r) => r.type === 'item'));
  await h.close();
});

test('tibia_search orders shortest-title-first so exact-ish matches surface', async () => {
  const h = await connect();
  const res = await h.client.callTool({ name: 'tibia_search', arguments: { query: 'dragon' } });
  const titles = (res.structuredContent as SearchOut).results.map((r) => r.title);
  assert.equal(titles[0], 'Dragon', `expected Dragon first, got ${JSON.stringify(titles.slice(0, 3))}`);
  await h.close();
});

test('tibia_search paginates with a stable opaque cursor', async () => {
  const h = await connect();
  const first = await h.client.callTool({
    name: 'tibia_search', arguments: { query: 'a', limit: 1 },
  });
  const d1 = first.structuredContent as SearchOut;
  assert.equal(d1.results.length, 1);
  assert.ok(d1.nextCursor, 'expected a nextCursor');
  const second = await h.client.callTool({
    name: 'tibia_search', arguments: { query: 'a', limit: 1, cursor: d1.nextCursor },
  });
  const d2 = second.structuredContent as SearchOut;
  assert.equal(d2.results.length, 1);
  assert.notDeepEqual(d1.results[0], d2.results[0], 'second page must differ from the first');
  await h.close();
});

test('tibia_search excludes non-active pages unless asked', async () => {
  const h = await connect();
  const off = await h.client.callTool({
    name: 'tibia_search', arguments: { query: 'a', types: ['creature'], limit: 100 },
  });
  const on = await h.client.callTool({
    name: 'tibia_search',
    arguments: { query: 'a', types: ['creature'], limit: 100, include_inactive: true },
  });
  const nOff = (off.structuredContent as SearchOut).results.length;
  const nOn = (on.structuredContent as SearchOut).results.length;
  assert.ok(nOn > nOff, `include_inactive should widen results (${nOff} -> ${nOn})`);
  await h.close();
});

test('a malformed cursor is reported, not silently treated as page one', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_search', arguments: { query: 'a', cursor: 'garbage' },
  });
  assert.equal(res.isError, true);
  await h.close();
});
