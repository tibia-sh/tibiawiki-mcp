import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { asciiLower } from '../src/domain.ts';
import { connect, connectTo, FIXTURE, tempDirs, withRealIndex } from './harness.ts';

type House = {
  title: string; city: string; street: string | null; rent: number | null; beds: number | null;
  size: number | null; rooms: number | null; floors: number | null; isGuildhall: boolean | null;
};
type Page = { results: House[]; totalMatches: number; nextCursor?: string; indexGeneratedAt: string };

const scratch = tempDirs('twmcp-fh-');

async function find(client: Client, args: Record<string, unknown>): Promise<Page> {
  const res = await client.callTool({ name: 'tibia_find_houses', arguments: args });
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Page;
}

/** Every page of a query, walked through nextCursor. */
async function findAll(client: Client, args: Record<string, unknown>): Promise<House[]> {
  const all: House[] = [];
  let cursor: string | undefined;
  do {
    const page = await find(client, { ...args, ...(cursor ? { cursor } : {}) });
    all.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/** Titles straight from the real index, so an expectation follows a data refresh. */
function realTitles(where: string): string[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return (db.prepare(`select title from house where ${where}`).all() as Array<{ title: string }>)
      .map((r) => r.title).sort();
  } finally {
    db.close();
  }
}

const titlesOf = (houses: House[]): string[] => houses.map((h) => h.title).sort();

/** Asserts `key` runs in `direction` with nulls last, and ties by title. Returns the tie count. */
function assertOrdered(found: House[], key: 'rent' | 'size', direction: 'asc' | 'desc'): number {
  let ties = 0;
  for (let i = 1; i < found.length; i++) {
    const [a, b] = [found[i - 1]!, found[i]!];
    if (b[key] === null) continue;
    assert.notEqual(a[key], null, `${a.title} has no ${key} but comes before ${b.title}`);
    const inOrder = direction === 'asc' ? a[key]! <= b[key]! : a[key]! >= b[key]!;
    assert.ok(inOrder, `${a.title} (${a[key]}) before ${b.title} (${b[key]})`);
    if (a[key] === b[key]) {
      ties++;
      assert.ok(asciiLower(a.title) < asciiLower(b.title), `tie at ${a[key]}: ${a.title} before ${b.title}`);
    }
  }
  return ties;
}

test('Thais houses at or under 50,000 rent are exactly those', async () => {
  await withRealIndex(async (client) => {
    const found = await findAll(client, { city: 'thais', rent_max: 50_000, limit: 100 });
    assert.ok(found.length > 0);
    for (const h of found) {
      assert.equal(h.city, 'Thais', h.title);
      assert.ok(h.rent !== null && h.rent <= 50_000, `${h.title} rent ${h.rent}`);
    }
    assert.deepEqual(
      titlesOf(found),
      realTitles("city = 'Thais' and rent <= 50000 and status = 'active'"),
    );
    // Exclusion both ways: pricier Thais houses and cheap houses elsewhere are left out.
    assert.ok(realTitles("city = 'Thais' and rent > 50000 and status = 'active'").length > 0);
    assert.ok(realTitles("city <> 'Thais' and rent <= 50000 and status = 'active'").length > 0);
  });
});

test('city is an exact name, not a substring', async () => {
  await withRealIndex(async (client) => {
    for (const city of ['thai', 'th_is', 'thais%', '%']) {
      assert.equal((await find(client, { city })).totalMatches, 0, city);
    }
    assert.equal((await find(client, { city: 'Liberty Bay' })).results[0]!.city, 'Liberty Bay');
  });
});

test('is_guildhall true includes Warriors\' Guildhall, and false leaves it out', async () => {
  await withRealIndex(async (client) => {
    const guildhalls = await findAll(client, { is_guildhall: true, limit: 100 });
    assert.ok(guildhalls.some((h) => h.title === "Warriors' Guildhall"));
    for (const h of guildhalls) assert.equal(h.isGuildhall, true, h.title);
    assert.deepEqual(titlesOf(guildhalls), realTitles("is_guildhall = 1 and status = 'active'"));
    const houses = await findAll(client, { is_guildhall: false, limit: 100 });
    assert.ok(houses.length > 0);
    assert.ok(!houses.some((h) => h.title === "Warriors' Guildhall"));
    for (const h of houses) assert.equal(h.isGuildhall, false, h.title);
  });
});

test('beds_min and size_min keep only houses that big', async () => {
  await withRealIndex(async (client) => {
    const found = await findAll(client, { beds_min: 4, size_min: 100, limit: 100 });
    assert.ok(found.length > 0);
    for (const h of found) {
      assert.ok(h.beds !== null && h.beds >= 4, `${h.title} beds ${h.beds}`);
      assert.ok(h.size !== null && h.size >= 100, `${h.title} size ${h.size}`);
    }
    assert.deepEqual(
      titlesOf(found),
      realTitles("beds >= 4 and size >= 100 and status = 'active'"),
    );
    assert.ok(realTitles("beds < 4 and size >= 100 and status = 'active'").length > 0);
    assert.ok(realTitles("beds >= 4 and size < 100 and status = 'active'").length > 0);
  });
});

test('the rent sort is the default and ascends across pages, with ties by title', async () => {
  await withRealIndex(async (client) => {
    const first = await find(client, { city: 'thais', limit: 9 });
    assert.ok(first.nextCursor, 'expected more than one page');
    const byDefault = await findAll(client, { city: 'thais', limit: 9 });
    const byRent = await findAll(client, { city: 'thais', sort: 'rent', limit: 100 });
    const titles = byDefault.map((h) => h.title);
    assert.equal(new Set(titles).size, titles.length, 'no page repeats a house');
    assert.equal(titles.length, first.totalMatches, 'no page skips a house');
    assert.deepEqual(titles, byRent.map((h) => h.title));
    assert.deepEqual([...titles].sort(), realTitles("city = 'Thais' and status = 'active'"));
    assert.ok(assertOrdered(byDefault, 'rent', 'asc') > 0, 'guard: Thais holds rent ties');
  });
});

test('the size sort descends, with ties by title', async () => {
  await withRealIndex(async (client) => {
    const found = await findAll(client, { sort: 'size', limit: 100 });
    assert.equal(found.length, (await find(client, {})).totalMatches);
    assert.ok(assertOrdered(found, 'size', 'desc') > 0, 'guard: the index holds size ties');
  });
});

test('the title sort ascends', async () => {
  await withRealIndex(async (client) => {
    const found = await findAll(client, { city: 'edron', sort: 'title', limit: 100 });
    assert.ok(found.length > 1);
    for (let i = 1; i < found.length; i++) {
      const [a, b] = [found[i - 1]!.title, found[i]!.title];
      assert.ok(asciiLower(a) < asciiLower(b), `${a} before ${b}`);
    }
  });
});

test('a house with no recorded rent or size sorts last', async () => {
  // The fixture's two houses have both, so this copy drops them from the pricier one.
  const path = join(scratch(), 'houses.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  try {
    db.exec("update house set rent = null, size = null where title = 'Warriors'' Guildhall'");
  } finally {
    db.close();
  }
  const h = await connectTo(path);
  try {
    for (const sort of ['rent', 'size']) {
      const found = await findAll(h.client, { sort });
      assert.deepEqual(found.map((x) => x.title), ['The Tibianic', "Warriors' Guildhall"], sort);
      assert.equal(found[1]!.rent, null);
    }
  } finally {
    await h.close();
  }
});

test('the fixture houses come back whole', async () => {
  const h = await connect();
  try {
    const page = await find(h.client, { city: 'THAIS', sort: 'size' });
    assert.deepEqual(page.results.map((x) => x.title), ['The Tibianic', "Warriors' Guildhall"]);
    const warriors = page.results[1]!;
    assert.deepEqual(warriors, {
      title: "Warriors' Guildhall", city: 'Thais', street: 'Temple Street', rent: 5_000_000,
      beds: 11, size: 305, rooms: 16, floors: 3, isGuildhall: true,
    });
    assert.equal(typeof page.indexGeneratedAt, 'string');
    assert.equal(page.nextCursor, undefined);
  } finally {
    await h.close();
  }
});

test('non-active houses are excluded by default', async () => {
  await withRealIndex(async (client) => {
    const off = await find(client, {});
    const on = await find(client, { include_inactive: true });
    assert.equal(off.totalMatches, realTitles("status = 'active'").length);
    assert.equal(on.totalMatches, realTitles('1').length);
    assert.ok(on.totalMatches > off.totalMatches, `${off.totalMatches} -> ${on.totalMatches}`);
  });
});

test('an input outside its schema is a schema error', async () => {
  const h = await connect();
  try {
    for (const bad of [{ sort: 'rowid' }, { sort: 'beds' }, { city: '' }, { limit: 0 }]) {
      const res = await h.client.callTool({ name: 'tibia_find_houses', arguments: bad });
      assert.equal(res.isError, true, `${JSON.stringify(bad)} must be rejected`);
      assert.match(JSON.stringify(res.content), /validation/i, JSON.stringify(res.content));
    }
  } finally {
    await h.close();
  }
});
