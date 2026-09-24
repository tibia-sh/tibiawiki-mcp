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

type ListOut = SearchOut & { totalMatches: number };

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

test('tibia_search with types and no query lists every page of them in title order', async () => {
  const h = await connect();
  try {
    const titles: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await h.client.callTool({
        name: 'tibia_search',
        arguments: { types: ['spell'], include_inactive: true, limit: 100, ...(cursor ? { cursor } : {}) },
      });
      const data = res.structuredContent as ListOut;
      assert.equal(data.totalMatches, 211);
      assert.ok(data.results.every((r) => r.type === 'spell'));
      titles.push(...data.results.map((r) => r.title));
      cursor = data.nextCursor;
    } while (cursor);
    assert.equal(titles.length, 211);
    assert.equal(new Set(titles).size, 211, 'no page repeats a spell');
    for (let i = 1; i < titles.length; i++) {
      const [a, b] = [titles[i - 1]!, titles[i]!];
      assert.ok(asciiLower(a) <= asciiLower(b), `${a} before ${b}`);
    }
  } finally {
    await h.close();
  }
});

test('tibia_search with types and no query still leaves out inactive pages by default', async () => {
  const h = await connect();
  try {
    const res = await h.client.callTool({ name: 'tibia_search', arguments: { types: ['spell'] } });
    assert.equal((res.structuredContent as ListOut).totalMatches, 195);
  } finally {
    await h.close();
  }
});

test('tibia_search counts a type listed twice once', async () => {
  const h = await connect();
  try {
    const res = await h.client.callTool({ name: 'tibia_search', arguments: { types: ['charm', 'charm'] } });
    const data = res.structuredContent as ListOut;
    assert.equal(data.totalMatches, 2);
    assert.deepEqual(data.results.map((r) => r.title), ['Adrenaline Burst', 'Bless']);
  } finally {
    await h.close();
  }
});

test('tibia_search with neither a query nor types asks for one', async () => {
  const h = await connect();
  try {
    for (const args of [{}, { types: [] }]) {
      const res = await h.client.callTool({ name: 'tibia_search', arguments: args });
      assert.equal(res.isError, true, JSON.stringify(args));
      const text = JSON.stringify(res.content);
      assert.match(text, /name fragment/i, text);
      assert.match(text, /types/, text);
    }
  } finally {
    await h.close();
  }
});

test('tibia_search rejects an empty query as a schema error', async () => {
  const h = await connect();
  try {
    const res = await h.client.callTool({ name: 'tibia_search', arguments: { query: '', types: ['spell'] } });
    assert.equal(res.isError, true);
    assert.match(JSON.stringify(res.content), /validation/i, JSON.stringify(res.content));
  } finally {
    await h.close();
  }
});

test('tibia_search describes both orders and the listing example', async () => {
  const h = await connect();
  try {
    const { tools } = await h.client.listTools();
    const description = tools.find((t) => t.name === 'tibia_search')!.description!;
    assert.match(description, /shortest/i);
    assert.match(description, /by title|title order/i);
    assert.match(description, /list every mount/);
  } finally {
    await h.close();
  }
});
