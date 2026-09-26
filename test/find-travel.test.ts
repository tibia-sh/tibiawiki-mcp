import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { FARE_MEANING, ORIGIN_MEANING } from '../src/domain.ts';
import { connect, connectTo, FIXTURE, tempDirs, withRealIndex } from './harness.ts';

type Route = {
  npc: string; city: string | null; subarea: string | null; location: string | null;
  position: { x: number | null; y: number | null; z: number | null };
  to: string; origin: string | null; price: number | null; notes: string | null;
};
type Page = { results: Route[]; totalMatches: number; nextCursor?: string; indexGeneratedAt: string };

const scratch = tempDirs('twmcp-ft-');

async function find(client: Client, args: Record<string, unknown>): Promise<Page> {
  const res = await client.callTool({ name: 'tibia_find_travel', arguments: args });
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Page;
}

/** Every page of a query, walked through nextCursor. */
async function findAll(client: Client, args: Record<string, unknown>): Promise<Route[]> {
  const all: Route[] = [];
  let cursor: string | undefined;
  do {
    const page = await find(client, { ...args, ...(cursor ? { cursor } : {}) });
    all.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/** The one route an NPC runs to a place at a fare, asserting the query found it. */
function route(found: Route[], npc: string, to: string, price?: number): Route {
  const hits = found.filter((r) => r.npc === npc && r.to === to &&
    (price === undefined || r.price === price));
  assert.equal(hits.length, 1, `${npc} to ${to}: ${JSON.stringify(hits)}`);
  return hits[0]!;
}

/** Asserts positive fares ascend first, then every zero. Returns how many zeros it saw. */
function assertFareOrder(found: Route[]): number {
  let zeros = 0;
  for (let i = 1; i < found.length; i++) {
    const [a, b] = [found[i - 1]!, found[i]!];
    if (a.price === 0) {
      assert.equal(b.price, 0, `${b.npc} to ${b.to} (${b.price}) after a zero fare`);
    } else if (b.price !== 0) {
      assert.ok(a.price! <= b.price!, `${a.npc} to ${a.to} (${a.price}) before ${b.npc} to ${b.to} (${b.price})`);
    }
  }
  for (const r of found) if (r.price === 0) zeros++;
  return zeros;
}

test('routes to Svargrond include Captain Greyhound from Carlin and Captain Bluebear from Thais', async () => {
  await withRealIndex(async (client) => {
    const found = await findAll(client, { to: 'svargrond' });
    for (const r of found) assert.equal(r.to, 'Svargrond', r.npc);
    const greyhound = route(found, 'Captain Greyhound', 'Svargrond');
    assert.equal(greyhound.city, 'Carlin');
    assert.equal(greyhound.price, 110);
    assert.deepEqual(greyhound.position, { x: 32388, y: 31822, z: 6 });
    assert.equal(greyhound.location, 'The boat at Carlin on Harbour Lane');
    const bluebear = route(found, 'Captain Bluebear', 'Svargrond');
    assert.equal(bluebear.city, 'Thais');
    assert.equal(bluebear.price, 180);
    assert.deepEqual(bluebear.position, { x: 32310, y: 32210, z: 6 });
  });
});

test('routes from Thais hold Captain Bluebear\'s and no Carlin NPC\'s', async () => {
  await withRealIndex(async (client) => {
    const found = await findAll(client, { from: 'thais', limit: 100 });
    for (const r of found) assert.equal(r.origin, 'Thais', `${r.npc} to ${r.to}`);
    assert.ok(found.filter((r) => r.npc === 'Captain Bluebear').length > 1);
    route(found, 'Captain Bluebear', 'Svargrond', 180);
    assert.ok(!found.some((r) => r.npc === 'Captain Greyhound'));
    // Exclusion guard: Carlin's NPCs exist and sail from Carlin.
    const carlin = await findAll(client, { from: 'carlin', limit: 100 });
    assert.ok(carlin.some((r) => r.npc === 'Captain Greyhound'));
  });
});

test('to and from together narrow to both', async () => {
  await withRealIndex(async (client) => {
    const found = await findAll(client, { to: 'Svargrond', from: 'Carlin' });
    assert.ok(found.length > 0);
    for (const r of found) {
      assert.equal(r.to, 'Svargrond');
      assert.equal(r.origin, 'Carlin');
    }
    assert.ok(found.some((r) => r.npc === 'Captain Greyhound'));
    assert.ok(!found.some((r) => r.npc === 'Captain Bluebear'));
  });
});

test('to and from are exact names, not substrings', async () => {
  const h = await connect();
  try {
    for (const args of [{ to: 'svarg' }, { to: '%' }, { to: 'svargron_' }, { from: 'thai' },
      { from: '%' }]) {
      assert.equal((await find(h.client, args)).totalMatches, 0, JSON.stringify(args));
    }
    assert.equal((await find(h.client, { to: 'SVARGROND' })).results[0]!.to, 'Svargrond');
    assert.equal((await find(h.client, { from: 'THAIS' })).results[0]!.origin, 'Thais');
  } finally {
    await h.close();
  }
});

test('the fixture\'s Thais routes come back whole, in fare order with the zero fare last', async () => {
  const h = await connect();
  try {
    const page = await find(h.client, { from: 'Thais', limit: 100 });
    assert.equal(page.totalMatches, page.results.length);
    assert.equal(page.nextCursor, undefined);
    assert.equal(typeof page.indexGeneratedAt, 'string');
    assert.equal(assertFareOrder(page.results), 1);
    const last = page.results.at(-1)!;
    assert.deepEqual(last, {
      npc: 'Captain Bluebear', city: 'Thais', subarea: null,
      location: 'Thais boat at Harbour and Main Street.',
      position: { x: 32310, y: 32210, z: 6 },
      to: 'Targuna', origin: 'Thais', price: 0,
      notes: 'After paying 5,000 or providing a Sail Pass',
    });
    assert.equal(page.results[0]!.price, 110);
  } finally {
    await h.close();
  }
});

// Review Focus 5: a zero fare means free or unrecorded, so it must not read as the cheapest.
test('the price sort is the default and puts every zero fare after every positive fare', async () => {
  await withRealIndex(async (client) => {
    for (const to of ['Travora', 'Tibia (Continent)']) {
      const byDefault = await findAll(client, { to, limit: 3 });
      const byPrice = await findAll(client, { to, sort: 'price', limit: 100 });
      assert.deepEqual(byDefault, byPrice, to);
      assert.ok(assertFareOrder(byDefault) > 0, `guard: some route to ${to} is free or unrecorded`);
    }
    const travora = await findAll(client, { to: 'Travora', limit: 100 });
    assert.ok(travora.some((r) => r.price! > 0), 'guard: some Travora route has a positive fare');
    assert.deepEqual([travora[0]!.npc, travora[0]!.price], ['Captain Bluebear', 1000]);
    assert.equal(route(travora, 'Captain Greyhound', 'Travora').price, 0);
  });
});

test('the npc sort orders by NPC, then destination, then fare', async () => {
  await withRealIndex(async (client) => {
    const found = await findAll(client, { to: 'Liberty Bay', sort: 'npc', limit: 4 });
    assert.ok(found.length > 1);
    for (let i = 1; i < found.length; i++) {
      const [a, b] = [found[i - 1]!, found[i]!];
      assert.ok(a.npc < b.npc || (a.npc === b.npc && a.price! <= b.price!),
        `${a.npc} (${a.price}) before ${b.npc} (${b.price})`);
    }
  });
});

test('paging with a small limit yields one large page, Sebastian\'s two Liberty Bay rows included', async () => {
  await withRealIndex(async (client) => {
    for (const sort of ['price', 'npc']) {
      const one = await find(client, { to: 'liberty bay', sort, limit: 100 });
      assert.equal(one.nextCursor, undefined, 'guard: one page holds them all');
      const paged = await findAll(client, { to: 'liberty bay', sort, limit: 2 });
      assert.ok(one.totalMatches > 2, 'guard: more than one small page');
      assert.deepEqual(paged, one.results, sort);
      assert.equal(paged.length, one.totalMatches, sort);
      const meriana = route(paged, 'Sebastian', 'Liberty Bay', 50);
      const nargor = paged.find((r) => r.npc === 'Sebastian' && r.notes === 'From Nargor');
      assert.equal(meriana.notes, 'From Meriana');
      assert.ok(nargor, 'Sebastian also sails to Liberty Bay from Nargor');
      assert.notEqual(nargor.price, meriana.price);
    }
  });
});

test('tibia_get and tibia_find_travel agree on Anderson\'s free ride and what it means', async () => {
  await withRealIndex(async (client) => {
    const got = await client.callTool({ name: 'tibia_get', arguments: { name: 'Anderson', type: 'npc' } });
    assert.notEqual(got.isError, true, JSON.stringify(got.content));
    const destinations = (got.structuredContent as {
      destinations: Array<{
        name: string; price: number | null; origin: string | null; notes: string | null;
      }>;
    }).destinations;
    const fromGet = destinations.filter((d) => d.name === 'Tibia (Continent)');
    assert.equal(fromGet.length, 1);
    const found = await findAll(client, { to: 'tibia (continent)', limit: 100 });
    const fromTravel = route(found, 'Anderson', 'Tibia (Continent)');
    assert.equal(fromTravel.price, 0);
    assert.equal(fromGet[0]!.price, fromTravel.price);
    assert.equal(fromGet[0]!.notes, fromTravel.notes);
    assert.equal(fromGet[0]!.origin, fromTravel.origin);
    assert.equal(fromTravel.origin, 'Carlin');

    const { tools } = await client.listTools();
    const output = (name: string): any => tools.find((t) => t.name === name)!.outputSchema;
    const npc = output('tibia_get').oneOf.find((b: any) => b.properties.type.const === 'npc');
    assert.equal(npc.properties.destinations.items.properties.price.description, FARE_MEANING);
    assert.equal(
      output('tibia_find_travel').properties.results.items.properties.price.description, FARE_MEANING);
    assert.equal(npc.properties.destinations.items.properties.origin.description, ORIGIN_MEANING);
    assert.equal(
      output('tibia_find_travel').properties.results.items.properties.origin.description, ORIGIN_MEANING);
    assert.match(FARE_MEANING, /0: free or not recorded, see notes/);
  });
});

/**
 * The active routes an index holds for one filter, in the order the brief sets, written here
 * apart from the tool's own ORDER BY: price puts positive fares ascending and every other fare
 * after them, and both sorts then run by NPC, destination, fare, notes and origin.
 */
function expectedRoutes(path: string, filter: { to?: string; from?: string },
  sort: 'price' | 'npc'): Route[] {
  const where = ["n.status = 'active'"];
  const params: string[] = [];
  if (filter.to !== undefined) {
    where.push('d.name = ? collate nocase');
    params.push(filter.to);
  }
  if (filter.from !== undefined) {
    where.push('d.origin = ? collate nocase');
    params.push(filter.from);
  }
  const fare = sort === 'price' ? 'case when d.price > 0 then d.price end asc nulls last, ' : '';
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(
      `select distinct n.title, n.city, n.subarea, n.location, n.x, n.y, n.z,
              d.name, d.origin, d.price, d.notes
         from npc_destination d join npc n on n.article_id = d.npc_id
        where ${where.join(' and ')}
        order by ${fare}n.title, d.name, d.price, d.notes, d.origin`,
    ).all(...params).map((r) => ({
      npc: String(r.title), city: r.city as string | null, subarea: r.subarea as string | null,
      location: r.location as string | null,
      position: { x: r.x as number | null, y: r.y as number | null, z: r.z as number | null },
      to: String(r.name), origin: r.origin as string | null, price: r.price as number | null,
      notes: r.notes as string | null,
    }));
  } finally {
    db.close();
  }
}

/** Every value of one column over the active routes, to query the tool once per value. */
function routeValues(path: string, column: 'd.origin' | 'd.name'): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare(
      `select distinct ${column} v from npc_destination d join npc n on n.article_id = d.npc_id
        where n.status = 'active' and ${column} is not null order by v`,
    ).all() as Array<{ v: string }>).map((r) => r.v);
  } finally {
    db.close();
  }
}

test('every active route pages in the brief\'s full order, by origin and by destination', async () => {
  const all = expectedRoutes(DB_PATH, {}, 'npc');
  assert.ok(all.length > 100, `guard: the index holds ${all.length} active routes`);
  // A leg with no recorded origin starts from another of the NPC's positions, so no from
  // value reaches it. Only to covers every route.
  const originless = all.filter((r) => r.origin === null).length;
  assert.ok(originless > 0, 'guard: some active routes have no recorded origin');
  await withRealIndex(async (client) => {
    for (const sort of ['price', 'npc'] as const) {
      for (const [key, column] of [['from', 'd.origin'], ['to', 'd.name']] as const) {
        let seen = 0;
        for (const value of routeValues(DB_PATH, column)) {
          const filter = { [key]: value };
          const paged = await findAll(client, { ...filter, sort, limit: 4 });
          assert.deepEqual(paged, expectedRoutes(DB_PATH, filter, sort), `${sort} ${key} ${value}`);
          seen += paged.length;
        }
        assert.equal(seen, key === 'from' ? all.length - originless : all.length,
          `${sort} ${key}: the queries cover every active route they can reach`);
      }
    }
    const sebastian = expectedRoutes(DB_PATH, { to: 'Liberty Bay' }, 'npc')
      .filter((r) => r.npc === 'Sebastian');
    assert.deepEqual(sebastian.map((r) => r.notes), ['From Meriana', 'From Nargor'],
      'guard: Sebastian\'s two Liberty Bay rows are covered');
  });
});

test('routes that differ only in notes page in notes order', async () => {
  // No recorded NPC has two routes to one place at one fare, so this copy gives Captain
  // Bluebear three more Carlin routes at 110, two of them apart only in origin, and another
  // Targuna route at 0.
  const path = join(scratch(), 'notes.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`insert into npc_destination (npc_id, name, price, notes, origin)
      select article_id, 'Carlin', 110, 'From Venore', 'Thais' from npc where title = 'Captain Bluebear'
      union all
      select article_id, 'Carlin', 110, 'From Edron', 'Thais' from npc where title = 'Captain Bluebear'
      union all
      select article_id, 'Carlin', 110, 'From Edron', 'Edron' from npc where title = 'Captain Bluebear'
      union all
      select article_id, 'Targuna', 0, 'A second note', 'Thais' from npc where title = 'Captain Bluebear'`);
  } finally {
    db.close();
  }
  const h = await connectTo(path);
  try {
    for (const sort of ['price', 'npc'] as const) {
      for (const filter of [{ from: 'Thais' }, { to: 'Carlin' }, { to: 'Targuna' }]) {
        const paged = await findAll(h.client, { ...filter, sort, limit: 2 });
        assert.deepEqual(paged, expectedRoutes(path, filter, sort), `${sort} ${JSON.stringify(filter)}`);
      }
      const carlin = await findAll(h.client, { to: 'Carlin', sort, limit: 1 });
      assert.deepEqual(carlin.map((r) => [r.notes, r.origin]),
        [[null, 'Thais'], ['From Edron', 'Edron'], ['From Edron', 'Thais'], ['From Venore', 'Thais']],
        sort);
      const targuna = await findAll(h.client, { to: 'Targuna', sort, limit: 1 });
      assert.deepEqual(targuna.map((r) => r.notes),
        ['A second note', 'After paying 5,000 or providing a Sail Pass'], sort);
    }
  } finally {
    await h.close();
  }
});

test('non-active NPCs\' routes are excluded by default', async () => {
  // Every fixture NPC with routes is active, so this copy retires Captain Bluebear.
  const path = join(scratch(), 'travel.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  try {
    db.exec("update npc set status = 'deprecated' where title = 'Captain Bluebear'");
  } finally {
    db.close();
  }
  const h = await connectTo(path);
  try {
    assert.equal((await find(h.client, { from: 'Thais' })).totalMatches, 0);
    const on = await find(h.client, { from: 'Thais', include_inactive: true });
    assert.ok(on.totalMatches > 0);
    for (const r of on.results) assert.equal(r.npc, 'Captain Bluebear');
  } finally {
    await h.close();
  }
});

test('a call without to or from is refused', async () => {
  const h = await connect();
  try {
    const res = await h.client.callTool({ name: 'tibia_find_travel', arguments: { sort: 'npc' } });
    assert.equal(res.isError, true);
    assert.deepEqual(res.content, [{ type: 'text', text: 'Pass to, from or both.' }]);
  } finally {
    await h.close();
  }
});

test('an input outside its schema is a schema error', async () => {
  const h = await connect();
  try {
    for (const bad of [
      { to: 'Carlin', sort: 'rowid' }, { to: 'Carlin', sort: 'title' }, { to: '' },
      { from: '' }, { to: 'Carlin', limit: 0 }, { to: 'Carlin', limit: 101 },
    ]) {
      const res = await h.client.callTool({ name: 'tibia_find_travel', arguments: bad });
      assert.equal(res.isError, true, `${JSON.stringify(bad)} must be rejected`);
      assert.match(JSON.stringify(res.content), /validation/i, JSON.stringify(res.content));
    }
  } finally {
    await h.close();
  }
});

// from_city was this input's name until origins were recorded. Dropped silently, it would
// turn {to, from_city} into every leg to that place.
test('the old from_city input and any other unknown key are schema errors', async () => {
  const h = await connect();
  try {
    for (const bad of [
      { from_city: 'Thais' }, { to: 'Carlin', from_city: 'Thais' }, { to: 'Carlin', bogus: 1 },
    ]) {
      const res = await h.client.callTool({ name: 'tibia_find_travel', arguments: bad });
      assert.equal(res.isError, true, `${JSON.stringify(bad)} must be rejected`);
      assert.match(JSON.stringify(res.content), /Input validation error.*Unrecognized key/,
        JSON.stringify(res.content));
    }
  } finally {
    await h.close();
  }
});

test('from matches the leg\'s start, so Sebastian sails from Meriana to Liberty Bay alone', async () => {
  const h = await connect();
  try {
    const page = await find(h.client, { from: 'meriana' });
    assert.deepEqual(page.results.map((r) => [r.npc, r.to, r.price, r.origin]),
      [['Sebastian', 'Liberty Bay', 50, 'Meriana']]);
    assert.equal(page.totalMatches, 1);
    const liberty = await findAll(h.client, { from: 'Liberty Bay' });
    for (const r of liberty) assert.equal(r.origin, 'Liberty Bay', `${r.npc} to ${r.to}`);
    assert.equal(route(liberty, 'Sebastian', 'Meriana').price, 50);
    assert.equal(route(liberty, 'Sebastian', 'Nargor').price, 50);
    assert.ok(!liberty.some((r) => r.to === 'Liberty Bay'), 'the legs into Liberty Bay start elsewhere');
  } finally {
    await h.close();
  }
});

test('a leg with no recorded origin comes back as null and no from value matches it', async () => {
  const h = await connect();
  try {
    const vengoth = await find(h.client, { to: 'Vengoth' });
    assert.equal(vengoth.totalMatches, 1);
    const harlow = vengoth.results[0]!;
    assert.deepEqual([harlow.npc, harlow.price, harlow.origin], ['Harlow', 100, null]);
    const from = await find(h.client, { from: 'Vengoth' });
    assert.deepEqual([from.totalMatches, from.results], [0, []]);
  } finally {
    await h.close();
  }
});

test('the tool and its from input describe legs by where they start', async () => {
  const h = await connect();
  try {
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === 'tibia_find_travel')!;
    assert.equal(tool.description,
      'Find boat, carpet and other travel routes to or from a place, with fares. Each row is one ' +
      'leg with its start (origin) and the NPC\'s recorded city, location and position. Rows are ' +
      'single legs: this does not plan journeys.');
    const input = tool.inputSchema as any;
    assert.equal(input.properties.from.description, 'Exact start place of the leg, e.g. "Meriana", any case.');
    assert.equal(input.properties.from_city, undefined);
    assert.equal(input.additionalProperties, false);
  } finally {
    await h.close();
  }
});
