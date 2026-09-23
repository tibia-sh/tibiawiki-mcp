import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { openDb } from '../src/db.ts';
import { createServer } from '../src/server.ts';

// The fixture holds two update pages, so these tests open the real packaged index, the
// way regression.test.ts does. They assert facts about historical update pages, which
// later data releases do not change, and membership rather than position.
async function withRealIndex<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const handle = openDb(DB_PATH);
  const server = createServer(handle);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'find-updates', version: '1.0.0' });
  await client.connect(ct);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
    handle.close();
  }
}

type Update = {
  title: string; name: string | null; releaseDate: string; version: string | null;
  updateType: string | null; summary: string | null; matchingLines: string[];
};
type Page = { results: Update[]; totalMatches: number; nextCursor?: string; indexGeneratedAt: string };

async function find(client: Client, args: Record<string, unknown>): Promise<Page> {
  const res = await client.callTool({ name: 'tibia_find_updates', arguments: args });
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Page;
}

async function findAll(client: Client, args: Record<string, unknown>): Promise<Update[]> {
  const all: Update[] = [];
  let cursor: string | undefined;
  do {
    const page = await find(client, { ...args, ...(cursor ? { cursor } : {}) });
    all.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

const VOCATION_2026 = 'Updates/15.25.3a4a52';
// A closed, historical range around it. The index gains updates every month, so an
// open-ended range would change what these tests see with each data release.
const FIRST_HALF_2026 = { released_after: '2026-01-01', released_before: '2026-06-30' };

test('knight in early 2026 finds the vocation rebalance with a stances line', () => withRealIndex(async (client) => {
  const results = await findAll(client, { text: 'knight', ...FIRST_HALF_2026, limit: 50 });
  const hit = results.find((r) => r.title === VOCATION_2026);
  assert.ok(hit, `expected ${VOCATION_2026} among ${JSON.stringify(results.map((r) => r.title))}`);
  assert.equal(hit.name, 'Vocation Adjustments 2026');
  assert.equal(hit.releaseDate, '2026-06-16');
  assert.equal(hit.version, '15.25.3a4a52');
  assert.ok(hit.summary?.startsWith('Rebalancing of all 5 vocations'), `summary: ${hit.summary}`);
  assert.ok(hit.matchingLines.some((l) => l.includes('stances')), JSON.stringify(hit.matchingLines));
  for (const r of results) {
    assert.ok(r.matchingLines.length <= 5, `${r.title} returned ${r.matchingLines.length} lines`);
    for (const line of r.matchingLines) {
      assert.match(line, /knight/i, `${r.title} returned a line without the text`);
      assert.ok(line.length <= 200, `${r.title} returned a line of ${line.length} characters`);
      assert.equal(line, line.trim(), 'lines are trimmed');
    }
  }
}));

test('text matches the update name', () => withRealIndex(async (client) => {
  const results = await findAll(client, { text: 'vocation adjustments', ...FIRST_HALF_2026, limit: 50 });
  assert.ok(results.some((r) => r.title === VOCATION_2026), JSON.stringify(results.map((r) => r.title)));
}));

test('date bounds are inclusive at both ends', () => withRealIndex(async (client) => {
  const after = await findAll(client, { released_after: '2026-06-16', released_before: '2026-06-30', limit: 50 });
  assert.ok(after.some((r) => r.title === VOCATION_2026), 'released_after includes its own day');
  const before = await findAll(client, { released_after: '2026-01-01', released_before: '2026-06-16', limit: 50 });
  assert.ok(before.some((r) => r.title === VOCATION_2026), 'released_before includes its own day');
  const day = await find(client, { released_after: '2026-06-16', released_before: '2026-06-16' });
  assert.ok(day.results.some((r) => r.title === VOCATION_2026), 'a one-day range includes that day');
  for (const r of day.results) assert.equal(r.releaseDate, '2026-06-16');
}));

test('results are newest first, then by title', () => withRealIndex(async (client) => {
  const all = await findAll(client, { released_after: '2020-01-01', released_before: '2026-06-30', limit: 50 });
  assert.ok(all.length > 10, 'guard: the range must hold several updates');
  for (let i = 1; i < all.length; i++) {
    const [a, b] = [all[i - 1]!, all[i]!];
    assert.ok(a.releaseDate >= b.releaseDate, `${a.title} (${a.releaseDate}) before ${b.title} (${b.releaseDate})`);
    if (a.releaseDate === b.releaseDate) {
      assert.ok(a.title.toLowerCase() <= b.title.toLowerCase(), `${a.title} before ${b.title} on the same day`);
    }
  }
}));

test('the cursor pages to the end without overlap or gaps', () => withRealIndex(async (client) => {
  const args = { ...FIRST_HALF_2026, limit: 2 };
  const first = await find(client, args);
  assert.ok(first.totalMatches > 4, `guard: need more than 4 updates, got ${first.totalMatches}`);
  assert.equal(first.results.length, 2);
  assert.ok(first.nextCursor, 'a partial first page carries a cursor');
  assert.equal(typeof first.indexGeneratedAt, 'string');

  const titles: string[] = [];
  let page: Page = first;
  for (;;) {
    titles.push(...page.results.map((r) => r.title));
    assert.equal(page.totalMatches, first.totalMatches, 'totalMatches counts every match on every page');
    if (!page.nextCursor) break;
    page = await find(client, { ...args, cursor: page.nextCursor });
  }
  assert.equal(new Set(titles).size, titles.length, 'no update appears twice');
  assert.equal(titles.length, first.totalMatches, 'every match is reached');
  const whole = await findAll(client, { ...FIRST_HALF_2026, limit: 50 });
  assert.deepEqual(titles, whole.map((r) => r.title), 'paging keeps the order of larger pages');
}));

test('without text, matchingLines is empty', () => withRealIndex(async (client) => {
  const results = await findAll(client, { ...FIRST_HALF_2026, limit: 50 });
  assert.ok(results.length > 0);
  for (const r of results) assert.deepEqual(r.matchingLines, [], r.title);
}));

test('%, _ and backslash match themselves', () => withRealIndex(async (client) => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    for (const ch of ['%', '_', '\\']) {
      const expected = (db.prepare(
        `select title from game_update where instr(title, ?) > 0 or instr(name, ?) > 0
          or instr(summary, ?) > 0 or instr(changes, ?) > 0`,
      ).all(ch, ch, ch, ch) as Array<{ title: string }>).map((r) => r.title).sort();
      const found = await findAll(client, { text: ch, limit: 50 });
      assert.deepEqual(found.map((r) => r.title).sort(), expected, `text ${JSON.stringify(ch)}`);
      for (const r of found) {
        for (const line of r.matchingLines) assert.ok(line.includes(ch), `${r.title}: ${line}`);
      }
      if (ch === '%') assert.ok(expected.length > 0, 'guard: some updates contain a literal %');
    }
  } finally {
    db.close();
  }
}));

test('a date that is not on the calendar is rejected', () => withRealIndex(async (client) => {
  for (const bad of ['2026-02-30', '2026-13-01', '2026-6-16', '16-06-2026']) {
    const res = await client.callTool({ name: 'tibia_find_updates', arguments: { released_after: bad } });
    assert.equal(res.isError, true, `${bad} must be rejected`);
    assert.match(JSON.stringify(res.content), /YYYY-MM-DD/, `${bad} gets the format in its message`);
  }
}));

test('crossed date bounds give zero results', () => withRealIndex(async (client) => {
  const page = await find(client, { released_after: '2026-12-01', released_before: '2026-01-01' });
  assert.deepEqual(page.results, []);
  assert.equal(page.totalMatches, 0);
  assert.equal(page.nextCursor, undefined);
}));

test('text that matches nothing gives zero results', () => withRealIndex(async (client) => {
  const page = await find(client, { text: 'zzqqxx-no-such-update' });
  assert.deepEqual(page.results, []);
  assert.equal(page.totalMatches, 0);
}));

test('a bad cursor is an error that says how to recover', () => withRealIndex(async (client) => {
  const res = await client.callTool({ name: 'tibia_find_updates', arguments: { cursor: 'nope' } });
  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res.content), /Invalid cursor/);
}));

test('tibia_get with the returned title gives the full changes', () => withRealIndex(async (client) => {
  const res = await client.callTool({ name: 'tibia_get', arguments: { name: VOCATION_2026, type: 'update' } });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  assert.ok(String((res.structuredContent as any).changes).includes('Protector'));
}));
