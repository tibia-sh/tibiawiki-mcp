import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { ENTITY_TYPES, asciiLower, entityHasStatus, entityTable } from '../src/domain.ts';
import { connect, connectTo, FIXTURE, tempDirs, withRealIndex } from './harness.ts';

const scratch = tempDirs('twmcp-search-');

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

/** Every page of a tibia_search call, walked through nextCursor. */
async function searchAll(client: Client, args: Record<string, unknown>): Promise<SearchOut['results']> {
  const all: SearchOut['results'] = [];
  let cursor: string | undefined;
  do {
    const res = await client.callTool({
      name: 'tibia_search', arguments: { ...args, ...(cursor ? { cursor } : {}) },
    });
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    const data = res.structuredContent as ListOut;
    all.push(...data.results);
    cursor = data.nextCursor;
  } while (cursor);
  return all;
}

test('tibia_search lists two types merged in title order across page boundaries', async () => {
  await withRealIndex(async (client) => {
    const small = await searchAll(client, { types: ['mount', 'outfit'], limit: 7 });
    const large = await searchAll(client, { types: ['mount', 'outfit'], limit: 100 });
    assert.deepEqual(small, large, 'the page size does not change the order');
    const keys = small.map((r) => `${r.type}:${r.title}`);
    assert.equal(new Set(keys).size, keys.length, 'no (type, title) pair repeats');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const expected = (db.prepare(
        `select 'mount' type, title from mount where status = 'active'
         union all select 'outfit', title from outfit where status = 'active'`,
      ).all() as Array<{ type: string; title: string }>).map((r) => `${r.type}:${r.title}`);
      assert.deepEqual([...keys].sort(), expected.sort(), 'no pair goes missing');
    } finally {
      db.close();
    }
    let switches = 0;
    for (let i = 1; i < small.length; i++) {
      const [a, b] = [small[i - 1]!, small[i]!];
      assert.ok(asciiLower(a.title) <= asciiLower(b.title), `${a.title} before ${b.title}`);
      if (a.type !== b.type) switches++;
    }
    assert.ok(switches > 1, 'guard: the two types interleave, so the merge is tested');
  });
});

test('tibia_search with a query counts a type listed twice once', async () => {
  const h = await connect();
  try {
    const call = async (args: Record<string, unknown>) => (await h.client.callTool({
      name: 'tibia_search', arguments: args,
    })).structuredContent as ListOut;
    const once = await call({ query: 'LESS', types: ['charm'] });
    const twice = await call({ query: 'LESS', types: ['charm', 'charm'] });
    const every = await call({ types: ['charm'] });
    assert.ok(once.totalMatches > 0, 'guard: the query matches a charm');
    assert.ok(once.totalMatches < every.totalMatches, 'the query leaves some charms out');
    for (const r of twice.results) assert.ok(asciiLower(r.title).includes('less'), r.title);
    assert.equal(twice.totalMatches, once.totalMatches);
    assert.deepEqual(twice.results, once.results);
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

test('an item also matches by the name and plural the game prints, once under its title', async () => {
  const h = await connect();
  try {
    const search = async (query: string) => {
      const res = await h.client.callTool({ name: 'tibia_search', arguments: { query, types: ['item'] } });
      return (res.structuredContent as SearchOut).results.map((r) => r.title);
    };
    // "small rub" is in Small Ruby's title, name and plural.
    assert.deepEqual((await search('small rub')).filter((t) => t === 'Small Ruby'), ['Small Ruby']);
    assert.ok((await search('small rubies')).includes('Small Ruby'), 'by plural');
    assert.ok((await search('AMBER')).includes('Amber (Item)'), 'by title');
  } finally {
    await h.close();
  }
  await withRealIndex(async (client) => {
    const res = await client.callTool({ name: 'tibia_search', arguments: { query: 'vials of life' } });
    assert.deepEqual(
      (res.structuredContent as SearchOut).results.filter((r) => r.title === 'Lifefluid'),
      [{ title: 'Lifefluid', type: 'item' }],
    );
  });
});

/**
 * What a search for `query` should return from the index at `path`, found with instr
 * rather than like, in the order tibia_search promises: shortest title first, then
 * alphabetical, then type.
 */
function expectedMatches(path: string, query: string, includeInactive: boolean): SearchOut['results'] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const found: SearchOut['results'] = [];
    for (const type of ENTITY_TYPES) {
      const columns = type === 'item' ? ['title', 'actual_name', 'plural'] : ['title'];
      const contains = columns.map((c) => `instr(lower(t.${c}), lower(?1)) > 0`).join(' or ');
      const active = entityHasStatus(type) && !includeInactive ? " and t.status = 'active'" : '';
      const rows = db.prepare(`select t.title from "${entityTable(type)}" t where (${contains})${active}`)
        .all(query) as Array<{ title: string }>;
      found.push(...rows.map((r) => ({ title: r.title, type })));
    }
    return found.sort((a, b) =>
      a.title.length - b.title.length || a.title.localeCompare(b.title) || a.type.localeCompare(b.type));
  } finally {
    db.close();
  }
}

/** The totalMatches a search reports on its first page. */
async function totalMatches(client: Client, args: Record<string, unknown>): Promise<number> {
  const res = await client.callTool({ name: 'tibia_search', arguments: { ...args, limit: 1 } });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  return (res.structuredContent as ListOut).totalMatches;
}

test('an ordinary query returns every substring match, in order, across pages', async () => {
  const h = await connect();
  try {
    for (const includeInactive of [false, true]) {
      for (const query of ['a', 'DRAG', 'small rubies', 'less', "'s", 'e']) {
        const expected = expectedMatches(FIXTURE, query, includeInactive);
        assert.ok(expected.length > 0, `guard: ${query} matches some page`);
        const args = { query, include_inactive: includeInactive };
        for (const limit of [7, 100]) {
          const found = await searchAll(h.client, { ...args, limit });
          assert.deepEqual(found, expected, `${query} inactive=${includeInactive} limit=${limit}`);
        }
        assert.equal(await totalMatches(h.client, args), expected.length,
          `${query} inactive=${includeInactive}`);
      }
    }
  } finally {
    await h.close();
  }
});

test('a %, _ or backslash that no page name holds matches nothing', async () => {
  const h = await connect();
  try {
    for (const ch of ['%', '_', '\\', 'a%', '%%', '__', '\\%']) {
      assert.deepEqual(expectedMatches(FIXTURE, ch, true), [], `guard: no fixture name holds ${ch}`);
      assert.equal(await totalMatches(h.client, { query: ch, include_inactive: true }), 0,
        `${JSON.stringify(ch)} is literal`);
    }
  } finally {
    await h.close();
  }
  await withRealIndex(async (client) => {
    for (const ch of ['%', '_', '\\']) {
      const found = await searchAll(client, { query: ch, include_inactive: true, limit: 100 });
      assert.deepEqual(found, expectedMatches(DB_PATH, ch, true), `real index ${JSON.stringify(ch)}`);
    }
  });
});

test('%, _ and backslash in a title, an in-game name and a plural match themselves', async () => {
  // No fixture name holds these characters, so this copy writes each into one title,
  // one item's in-game name and one item's plural. The item rows keep plain titles,
  // so only the in-game name or plural clause can match them.
  const edits = [
    { ch: '%', table: 'creature', column: 'title', title: 'Bonelord', value: 'Bone%Lord' },
    { ch: '%', table: 'item', column: 'actual_name', title: 'Fire Sword', value: 'fire 50% sword' },
    { ch: '%', table: 'item', column: 'plural', title: 'Giant Sword', value: 'giant 50% swords' },
    { ch: '_', table: 'spell', column: 'title', title: 'Light Healing', value: 'Light_Healing' },
    { ch: '_', table: 'item', column: 'actual_name', title: 'Serpent Sword', value: 'serpent_sword' },
    { ch: '_', table: 'item', column: 'plural', title: 'Life Crystal', value: 'life_crystals' },
    { ch: '\\', table: 'world', column: 'title', title: 'Antica', value: 'Ant\\ica' },
    { ch: '\\', table: 'item', column: 'actual_name', title: 'Power Bolt', value: 'power\\bolt' },
    { ch: '\\', table: 'item', column: 'plural', title: 'Talon', value: 'tal\\ons' },
  ];
  const path = join(scratch(), 'literal.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  try {
    for (const e of edits) {
      const { changes } = db.prepare(`update "${e.table}" set ${e.column} = ? where title = ?`)
        .run(e.value, e.title);
      assert.equal(changes, 1, `guard: ${e.table} ${e.title} is edited`);
    }
  } finally {
    db.close();
  }
  const h = await connectTo(path);
  try {
    for (const e of edits) {
      const title = e.column === 'title' ? e.value : e.title;
      const at = e.value.indexOf(e.ch);
      // The character alone, and uppercased with its neighbours, which as a wildcard
      // would also match names that do not hold it.
      for (const query of [e.ch, e.value.slice(at - 1, at + 2).toUpperCase()]) {
        const expected = expectedMatches(path, query, false);
        assert.ok(expected.some((r) => r.title === title), `guard: ${query} is in ${e.value}`);
        const label = `${JSON.stringify(query)}, written into ${e.table}.${e.column}`;
        assert.deepEqual(await searchAll(h.client, { query, limit: 2 }), expected, label);
        assert.equal(await totalMatches(h.client, { query }), expected.length, label);
      }
      if (e.column !== 'title') assert.ok(!title.includes(e.ch), `guard: ${title} matches by ${e.column}`);
    }
    for (const ch of ['%', '_', '\\']) {
      assert.equal(await totalMatches(h.client, { query: ch }), 3,
        `${JSON.stringify(ch)} matches only the three edited pages`);
    }
  } finally {
    await h.close();
  }
});
