import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import {
  runsAtSchema, summonCostSchema, convinceCostSchema, goldPerKillSchema, asciiLower,
  RACE_ID_MEANING, raceIdSchema,
} from '../src/domain.ts';
import { connect, connectTo, FIXTURE, tempDirs, withRealIndex } from './harness.ts';

type Creature = {
  title: string; name: string | null; hitpoints: number | null; experience: number | null;
  bestiaryClass: string | null; modifiers: Record<string, number | null>;
  runsAt: number | null; seesInvisible: boolean | null; paralysable: boolean | null;
  pushable: boolean | null; summonCost: number | null; convinceCost: number | null;
  goldPerKill: number | null; raceId: number | null;
};
type FindOut = { results: Creature[]; totalMatches: number; nextCursor?: string };

const scratch = tempDirs('twmcp-fc-');

async function find(client: Client, args: Record<string, unknown>): Promise<FindOut> {
  const res = await client.callTool({ name: 'tibia_find_creatures', arguments: args });
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  return res.structuredContent as FindOut;
}

/** Every page of a query, walked through nextCursor. */
async function findAll(client: Client, args: Record<string, unknown>): Promise<Creature[]> {
  const all: Creature[] = [];
  let cursor: string | undefined;
  do {
    const page = await find(client, { ...args, limit: 100, ...(cursor ? { cursor } : {}) });
    all.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/** Sorted titles of the active creatures in the fixture matching `where`. */
function fixtureTitles(where: string): string[] {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  try {
    return (db.prepare(`select title from creature where (${where}) and status = 'active'`)
      .all() as Array<{ title: string }>).map((r) => r.title).sort();
  } finally {
    db.close();
  }
}

const titlesOf = (found: Creature[]): string[] => found.map((c) => c.title).sort();

/** `tibia_get`'s goldPerKill for one creature. */
async function getGold(client: Client, name: string): Promise<number | null> {
  const res = await client.callTool({ name: 'tibia_get', arguments: { name } });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const detail = res.structuredContent as Record<string, unknown>;
  assert.ok('goldPerKill' in detail, `tibia_get reports goldPerKill for ${name}`);
  return detail.goldPerKill as number | null;
}

/**
 * The gold-per-kill rule written independently of src/domain.ts: coins at face value, other
 * items at the highest Gold Coin price an active NPC pays, each drop with a chance weighted by
 * it and by its average amount. Null when the creature has no drop with a chance.
 */
function expectedGold(db: DatabaseSync, title: string): number | null {
  const row = db.prepare(
    `with coin(title, face) as (values ('Gold Coin', 1), ('Platinum Coin', 100), ('Crystal Coin', 10000))
     select count(*) as drops, sum(d.chance / 100.0
       * iif(d.min = 0, d.max, (d.min + d.max) / 2.0)
       * coalesce(
           (select face from coin where coin.title = i.title),
           (select max(o.value) from npc_offer_buy o
              join npc n on n.article_id = o.npc_id
              join item cur on cur.article_id = o.currency_id
             where o.item_id = d.item_id and n.status = 'active' and cur.title = 'Gold Coin'),
           0)) as gold
     from creature_drop d
     join creature c on c.article_id = d.creature_id
     join item i on i.article_id = d.item_id
     where c.title = ? and d.chance is not null`,
  ).get(title) as { drops: number; gold: number | null };
  return row.drops === 0 ? null : Math.round(row.gold!);
}

/**
 * Asserts the rows are in gold_per_kill order: highest first, ties by title, nulls last, and
 * no creature twice. creature.title is collate nocase, so titles compare with ASCII case folded. Returns them split into the priced and the null part.
 */
function assertGoldOrder(found: Creature[]): { priced: Creature[]; unpriced: Creature[] } {
  assert.equal(new Set(found.map((c) => c.title)).size, found.length, 'no creature repeats');
  const firstNull = found.findIndex((c) => c.goldPerKill === null);
  const priced = firstNull === -1 ? found : found.slice(0, firstNull);
  const unpriced = firstNull === -1 ? [] : found.slice(firstNull);
  for (const c of unpriced) assert.equal(c.goldPerKill, null, `${c.title} sorts after the nulls began`);
  for (let i = 1; i < unpriced.length; i++) {
    const [a, b] = [unpriced[i - 1]!, unpriced[i]!];
    assert.ok(asciiLower(a.title) < asciiLower(b.title), `${a.title} before ${b.title} among the nulls`);
  }
  for (let i = 1; i < priced.length; i++) {
    const [a, b] = [priced[i - 1]!, priced[i]!];
    assert.ok(a.goldPerKill! >= b.goldPerKill!, `${a.title} ${a.goldPerKill} before ${b.title} ${b.goldPerKill}`);
    if (a.goldPerKill === b.goldPerKill) {
      assert.ok(asciiLower(a.title) < asciiLower(b.title), `${a.title} before ${b.title} on a tie`);
    }
  }
  return { priced, unpriced };
}

test('finds creatures weak to an element above an experience floor', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures',
    arguments: { weak_to: ['fire'], experience_min: 100 },
  });
  const data = res.structuredContent as FindOut;
  // Assert non-emptiness FIRST: a universal assertion over an empty array passes
  // vacuously, which is exactly how this test was broken before the fixture was fixed.
  assert.ok(data.results.length >= 2, `expected >=2 matches, got ${data.results.length}`);
  for (const r of data.results) {
    assert.ok(r.modifiers.fire! > 100, `${r.title} fire=${r.modifiers.fire} should exceed 100`);
    assert.ok(r.experience! >= 100, `${r.title} exp=${r.experience}`);
  }
  await h.close();
});

test('Dragon is excluded from a fire-weakness search because it is fire-immune', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { weak_to: ['fire'], limit: 100 },
  });
  const titles = (res.structuredContent as FindOut).results.map((r) => r.title);
  assert.ok(titles.length > 0, 'guard: the set must be non-empty for this to mean anything');
  assert.ok(!titles.includes('Dragon'), 'Dragon has modifier_fire = 0 and must not match');
  await h.close();
});

test('resistant_to is the inverse of weak_to', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { resistant_to: ['fire'], limit: 100 },
  });
  const data = res.structuredContent as FindOut;
  assert.ok(data.results.length > 0);
  for (const r of data.results) assert.ok(r.modifiers.fire! < 100, `${r.title}`);
  await h.close();
});

test('paginates with an opaque cursor and stops at the last page', async () => {
  const h = await connect();
  const first = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { weak_to: ['fire'], limit: 1 },
  });
  const d1 = first.structuredContent as FindOut;
  assert.equal(d1.results.length, 1);
  assert.ok(d1.nextCursor, 'expected a nextCursor with >1 total match');
  const second = await h.client.callTool({
    name: 'tibia_find_creatures',
    arguments: { weak_to: ['fire'], limit: 1, cursor: d1.nextCursor },
  });
  const d2 = second.structuredContent as FindOut;
  assert.notEqual(d1.results[0]!.title, d2.results[0]!.title);
  const last = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { weak_to: ['fire'], limit: 100 },
  });
  assert.equal((last.structuredContent as FindOut).nextCursor, undefined, 'final page has no cursor');
  await h.close();
});

test('non-active creatures are excluded by default', async () => {
  const h = await connect();
  const off = await h.client.callTool({ name: 'tibia_find_creatures', arguments: { limit: 100 } });
  const on = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { limit: 100, include_inactive: true },
  });
  assert.ok(
    (on.structuredContent as FindOut).totalMatches > (off.structuredContent as FindOut).totalMatches,
  );
  await h.close();
});

test('filters combine, and totalMatches reflects the filter not the page', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures',
    arguments: { hitpoints_min: 100, hitpoints_max: 100000, sort: 'hitpoints', limit: 2 },
  });
  const data = res.structuredContent as FindOut;
  assert.equal(data.results.length, 2);
  assert.ok(data.totalMatches > 2, 'totalMatches must count all matches, not the page');
  assert.ok(data.results[0]!.hitpoints! >= data.results[1]!.hitpoints!, 'sorted descending');
  await h.close();
});

test('a result row carries its in-game name and how the creature behaves', async () => {
  const h = await connect();
  try {
    const dragon = (await findAll(h.client, { bestiary_class: 'Dragon' })).find((c) => c.title === 'Dragon');
    assert.ok(dragon, 'guard: Dragon is in the fixture');
    assert.equal(dragon.name, 'dragon');
    assert.equal(dragon.runsAt, 300);
    assert.equal(dragon.seesInvisible, true);
    assert.equal(dragon.paralysable, true);
    assert.equal(dragon.pushable, false);
    assert.equal(dragon.summonCost, 0);
    assert.equal(dragon.convinceCost, 0);
  } finally {
    await h.close();
  }
});

test('sees_invisible, paralysable and pushable filter both ways', async () => {
  const h = await connect();
  try {
    for (const [arg, column, field] of [
      ['sees_invisible', 'sees_invisible', 'seesInvisible'],
      ['paralysable', 'paralysable', 'paralysable'],
      ['pushable', 'pushable', 'pushable'],
    ] as const) {
      for (const value of [true, false]) {
        const found = await findAll(h.client, { [arg]: value });
        const expected = fixtureTitles(`${column} = ${value ? 1 : 0}`);
        assert.ok(expected.length > 0, `guard: the fixture holds creatures with ${column} ${value}`);
        assert.deepEqual(titlesOf(found), expected, `${arg}: ${value}`);
        for (const c of found) assert.equal(c[field], value, `${c.title} ${field}`);
      }
    }
    // Dragon sees invisible, is paralysable and cannot be pushed.
    const has = async (args: Record<string, unknown>) =>
      (await findAll(h.client, args)).some((c) => c.title === 'Dragon');
    assert.ok(await has({ sees_invisible: true }));
    assert.ok(!(await has({ sees_invisible: false })));
    assert.ok(await has({ paralysable: true }));
    assert.ok(!(await has({ paralysable: false })));
    assert.ok(await has({ pushable: false }));
    assert.ok(!(await has({ pushable: true })));
  } finally {
    await h.close();
  }
});

test('summonable and convinceable split on a cost above 0', async () => {
  const h = await connect();
  try {
    for (const [arg, column, field] of [
      ['summonable', 'summon_cost', 'summonCost'],
      ['convinceable', 'convince_cost', 'convinceCost'],
    ] as const) {
      for (const value of [true, false]) {
        const found = await findAll(h.client, { [arg]: value });
        const expected = fixtureTitles(`${column} ${value ? '> 0' : '= 0'}`);
        assert.ok(expected.length > 0, `guard: the fixture holds creatures with ${column} ${value}`);
        assert.deepEqual(titlesOf(found), expected, `${arg}: ${value}`);
        for (const c of found) {
          assert.ok(value ? c[field]! > 0 : c[field] === 0, `${c.title} ${field} ${c[field]}`);
        }
      }
    }
  } finally {
    await h.close();
  }
});

test('Fire Elemental can be summoned but not convinced, Rotworm the other way', () =>
  withRealIndex(async (client) => {
    const titles = async (args: Record<string, unknown>) => titlesOf(await findAll(client, args));
    const summonable = await titles({ summonable: true });
    assert.ok(summonable.includes('Fire Elemental'));
    assert.ok(!summonable.includes('Rotworm'));
    assert.ok((await titles({ summonable: false })).includes('Rotworm'));
    const convinceable = await titles({ convinceable: true });
    assert.ok(convinceable.includes('Rotworm'));
    assert.ok(!convinceable.includes('Fire Elemental'));
    assert.ok((await titles({ convinceable: false })).includes('Fire Elemental'));
  }));

test('a creature whose behaviour is unrecorded matches neither value of a filter', async () => {
  // The fixture records every one of these for every creature, so this copy blanks Dragon's.
  const path = join(scratch(), 'creatures.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`update creature set runs_at = null, sees_invisible = null, paralysable = null,
      pushable = null, push_objects = null, illusionable = null, summon_cost = null,
      convince_cost = null, bestiary_level = null where title = 'Dragon'`);
  } finally {
    db.close();
  }
  const h = await connectTo(path);
  try {
    for (const arg of ['sees_invisible', 'paralysable', 'pushable', 'summonable', 'convinceable']) {
      for (const value of [true, false]) {
        const found = await findAll(h.client, { [arg]: value });
        assert.ok(found.length > 0, `guard: ${arg} ${value} matches some creature`);
        assert.ok(!found.some((c) => c.title === 'Dragon'), `${arg}: ${value} excludes Dragon`);
      }
    }
    const dragon = (await findAll(h.client, { bestiary_class: 'Dragon' })).find((c) => c.title === 'Dragon');
    assert.ok(dragon, 'guard: Dragon is still found without the filters');
    for (const field of ['seesInvisible', 'paralysable', 'pushable', 'summonCost', 'convinceCost'] as const) {
      assert.equal(dragon[field], null, field);
    }
    const res = await h.client.callTool({ name: 'tibia_get', arguments: { name: 'Dragon' } });
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    const detail = res.structuredContent as Record<string, unknown>;
    for (const field of [
      'runsAt', 'seesInvisible', 'paralysable', 'pushable', 'pushObjects', 'illusionable',
      'summonCost', 'convinceCost', 'bestiaryLevel',
    ]) {
      assert.ok(field in detail, `tibia_get reports ${field}`);
      assert.equal(detail[field], null, `tibia_get ${field}`);
    }
  } finally {
    await h.close();
  }
});

test('bestiary_level keeps only creatures of that level', async () => {
  const h = await connect();
  try {
    const found = titlesOf(await findAll(h.client, { bestiary_level: 'medium' }));
    const expected = fixtureTitles("bestiary_level = 'Medium'");
    assert.ok(expected.length > 0, 'guard: the fixture holds Medium creatures');
    assert.deepEqual(found, expected);
    assert.ok(found.includes('Dragon'));
    assert.ok(!found.includes('Rotworm'), 'Rotworm is Easy');
    const unrecorded = fixtureTitles('bestiary_level is null');
    assert.ok(unrecorded.length > 0, 'guard: the fixture holds creatures with no bestiary level');
    for (const title of unrecorded) assert.ok(!found.includes(title), `${title} has no level`);
  } finally {
    await h.close();
  }
});

test('a bestiary_level outside its enum is a schema error', async () => {
  const h = await connect();
  try {
    for (const bad of [{ bestiary_level: 'legendary' }, { bestiary_level: 'Medium' }]) {
      const res = await h.client.callTool({ name: 'tibia_find_creatures', arguments: bad });
      assert.equal(res.isError, true, `${JSON.stringify(bad)} must be rejected`);
      assert.match(JSON.stringify(res.content), /validation/i, JSON.stringify(res.content));
    }
  } finally {
    await h.close();
  }
});

test('location_contains matches a literal substring, case-insensitively', async () => {
  const h = await connect();
  try {
    const found = titlesOf(await findAll(h.client, { location_contains: 'ANCIENT TEMPLE' }));
    const expected = fixtureTitles("lower(location) like '%ancient temple%'");
    assert.ok(expected.includes('Dragon'), 'guard: Dragon lives in the Ancient Temple');
    assert.ok(expected.length < fixtureTitles('1').length, 'guard: some creatures live elsewhere');
    assert.deepEqual(found, expected);
    // No fixture location holds _ or a backslash, so as wildcards they would match every creature.
    for (const ch of ['_', '\\']) {
      assert.equal((await find(h.client, { location_contains: ch })).totalMatches, 0, `${ch} is literal`);
    }
  } finally {
    await h.close();
  }
});

test('%, _ and backslash in location_contains match themselves', () => withRealIndex(async (client) => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const count = (sql: string, ...params: string[]) =>
      (db.prepare(`select count(*) c from creature where (${sql}) and status = 'active'`)
        .get(...params) as { c: number }).c;
    const located = count('location is not null');
    for (const ch of ['%', '_', '\\']) {
      const expected = count('instr(location, ?) > 0', ch);
      const found = await find(client, { location_contains: ch, limit: 1 });
      assert.equal(found.totalMatches, expected, `location_contains ${JSON.stringify(ch)}`);
      assert.ok(found.totalMatches < located, `${JSON.stringify(ch)} does not match every location`);
      if (ch === '%') assert.ok(expected > 0, 'guard: some creature location holds a literal %');
    }
  } finally {
    db.close();
  }
}));

test('both tools describe what 0 means in the same words, and name unrecorded levels', async () => {
  const h = await connect();
  try {
    const { tools } = await h.client.listTools();
    const tool = (name: string) => {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `guard: ${name} is listed`);
      return t;
    };
    const find = tool('tibia_find_creatures');
    const row = (find.outputSchema as any).properties.results.items.properties;
    const get = JSON.stringify(tool('tibia_get').outputSchema);
    for (const [field, schema] of [
      ['runsAt', runsAtSchema], ['summonCost', summonCostSchema], ['convinceCost', convinceCostSchema],
      ['goldPerKill', goldPerKillSchema],
    ] as const) {
      assert.ok(schema.description, `${field} has a description`);
      assert.equal(row[field].description, schema.description, `tibia_find_creatures ${field}`);
      assert.ok(get.includes(JSON.stringify(schema.description)), `tibia_get ${field}`);
    }
    assert.equal(runsAtSchema.description, 'Hit points at which it flees. 0: never flees.');
    assert.match(goldPerKillSchema.description!, /NPC prices/);
    assert.match(goldPerKillSchema.description!, /without a recorded chance/);
    assert.match(goldPerKillSchema.description!, /market/);
    const sort = (find.inputSchema as any).properties.sort.description as string;
    assert.match(sort, /gold_per_kill/);
    assert.match(sort, /highest first/);
    const level = (find.inputSchema as any).properties.bestiary_level.description as string;
    assert.match(level, /no recorded bestiary level are excluded/);
  } finally {
    await h.close();
  }
});

test('goldPerKill for Dragon and Dragon Lord matches the rule, in both tools', () =>
  withRealIndex(async (client) => {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const found = await findAll(client, { bestiary_class: 'Dragon' });
      for (const title of ['Dragon', 'Dragon Lord']) {
        const expected = expectedGold(db, title);
        assert.ok(expected !== null && expected > 0, `guard: ${title} has priced drops, got ${expected}`);
        const row = found.find((c) => c.title === title);
        assert.ok(row, `guard: ${title} is found`);
        assert.equal(row.goldPerKill, expected, `tibia_find_creatures ${title}`);
        assert.equal(await getGold(client, title), expected, `tibia_get ${title}`);
      }
    } finally {
      db.close();
    }
  }));

test('goldPerKill is null without a chanced drop and 0 when no drop is priced', () =>
  withRealIndex(async (client) => {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      // Has drops, and not one of them has a recorded chance.
      const noChance = db.prepare(
        `select c.title from creature c join creature_drop d on d.creature_id = c.article_id
          where c.status = 'active' group by c.article_id
         having count(d.chance) = 0 order by c.title limit 1`).get() as { title: string } | undefined;
      // Has drops with a chance, none of them a coin or bought for Gold Coins by an active NPC.
      const unpriced = db.prepare(
        `select c.title from creature c
           join creature_drop d on d.creature_id = c.article_id and d.chance is not null
           join item i on i.article_id = d.item_id
          where c.status = 'active' group by c.article_id
         having sum(i.title in ('Gold Coin', 'Platinum Coin', 'Crystal Coin') or exists (
           select 1 from npc_offer_buy o join npc n on n.article_id = o.npc_id
             join item cur on cur.article_id = o.currency_id
            where o.item_id = d.item_id and n.status = 'active' and cur.title = 'Gold Coin')) = 0
          order by c.title limit 1`).get() as { title: string } | undefined;
      assert.ok(noChance, 'guard: some creature has drops but no chance on any');
      assert.ok(unpriced, 'guard: some creature has chanced drops that no one buys for gold');
      assert.equal(expectedGold(db, noChance.title), null);
      assert.equal(expectedGold(db, unpriced.title), 0);

      assert.equal(await getGold(client, noChance.title), null, `tibia_get ${noChance.title}`);
      assert.equal(await getGold(client, unpriced.title), 0, `tibia_get ${unpriced.title}`);
      const all = await findAll(client, { sort: 'gold_per_kill' });
      const { priced, unpriced: nulls } = assertGoldOrder(all);
      assert.ok(nulls.some((c) => c.title === noChance.title), `${noChance.title} sorts with the nulls`);
      assert.ok(priced.some((c) => c.title === unpriced.title && c.goldPerKill === 0),
        `${unpriced.title} is 0, among the priced`);
    } finally {
      db.close();
    }
  }));

test('sort gold_per_kill pages highest first, nulls last, with no repeats', async () => {
  const h = await connect();
  try {
    for (const args of [{}, { is_boss: false }, { weak_to: ['holy'] }]) {
      const pages: Creature[] = [];
      let cursor: string | undefined;
      let total = 0;
      do {
        const page = await find(h.client, { ...args, sort: 'gold_per_kill', limit: 7, ...(cursor ? { cursor } : {}) });
        pages.push(...page.results);
        total = page.totalMatches;
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(pages.length, total, `${JSON.stringify(args)} walks every match`);
      assert.ok(total > 7, `guard: ${JSON.stringify(args)} spans pages`);
      const { priced, unpriced } = assertGoldOrder(pages);
      assert.ok(priced.length > 0, `guard: ${JSON.stringify(args)} has priced creatures`);
      if (Object.keys(args).length === 0) assert.ok(unpriced.length > 0, 'guard: some creature has no gold value');
      // The same creatures as the default sort, so the join neither drops nor adds a row.
      assert.deepEqual(titlesOf(pages), titlesOf(await findAll(h.client, args)), JSON.stringify(args));
    }
  } finally {
    await h.close();
  }
});

test('an item bought only by an inactive NPC adds nothing, and duplicate offers change nothing', async () => {
  // The Plasmother always drops one The Plasmother's Remains, which only Yasir buys, and he
  // is an event NPC. In the fixture every gold buyer of it is inactive.
  const fixture = new DatabaseSync(FIXTURE, { readOnly: true });
  const buyers = fixture.prepare(
    `select n.status, o.value from npc_offer_buy o join npc n on n.article_id = o.npc_id
      join item i on i.article_id = o.item_id where i.title = 'The Plasmother''s Remains'`).all();
  const drop = fixture.prepare(
    `select d.chance, d.min, d.max from creature_drop d join creature c on c.article_id = d.creature_id
      join item i on i.article_id = d.item_id
      where c.title = 'The Plasmother' and i.title = 'The Plasmother''s Remains'`).get();
  const before = expectedGold(fixture, 'The Plasmother');
  fixture.close();
  assert.deepEqual(buyers.map((b) => ({ ...b })), [{ status: 'event', value: 50000 }], 'guard: only Yasir buys it');
  assert.deepEqual({ ...drop }, { chance: 100, min: 0, max: 1 }, 'guard: always one, stored as 0-1');
  assert.ok(before !== null, 'guard: The Plasmother has chanced drops');

  const h = await connect();
  try {
    assert.equal(await getGold(h.client, 'The Plasmother'), before, 'the inactive buyer is left out');
  } finally {
    await h.close();
  }

  // The same index with Yasir active and every offer stored twice: his 50,000 now counts,
  // once, for the one item a 0-1 drop gives.
  const path = join(scratch(), 'gold.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`update npc set status = 'active' where title = 'Yasir';
      insert into npc_offer_buy select * from npc_offer_buy;`);
  } finally {
    db.close();
  }
  const flipped = await connectTo(path);
  try {
    assert.equal(await getGold(flipped.client, 'The Plasmother'), before + 50000);
    const dragon = (await findAll(flipped.client, { bestiary_class: 'Dragon' })).find((c) => c.title === 'Dragon');
    const fixtureDb = new DatabaseSync(FIXTURE, { readOnly: true });
    try {
      assert.equal(dragon?.goldPerKill, expectedGold(fixtureDb, 'Dragon'), 'duplicate offers leave Dragon as it was');
    } finally {
      fixtureDb.close();
    }
  } finally {
    await flipped.close();
  }
});

test('a Crystal Coin counts 10,000 gold', async () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  let drop: { title: string; chance: number; min: number; max: number } | undefined;
  let expected: number | null;
  try {
    drop = db.prepare(
      `select c.title, d.chance, d.min, d.max from creature_drop d
         join creature c on c.article_id = d.creature_id join item i on i.article_id = d.item_id
        where i.title = 'Crystal Coin' and d.chance is not null and c.status = 'active'
        order by c.title limit 1`).get() as typeof drop;
    assert.ok(drop, 'guard: some active creature drops Crystal Coins with a chance');
    expected = expectedGold(db, drop.title);
  } finally {
    db.close();
  }
  const h = await connect();
  try {
    assert.equal(await getGold(h.client, drop.title), expected, `${drop.title} matches the rule`);
  } finally {
    await h.close();
  }

  // The same creature with only its Crystal Coin drop left is worth exactly that drop.
  const path = join(scratch(), 'crystal.db');
  copyFileSync(FIXTURE, path);
  const scratchDb = new DatabaseSync(path);
  try {
    scratchDb.prepare(`delete from creature_drop
      where creature_id = (select article_id from creature where title = ?)
        and item_id != (select article_id from item where title = 'Crystal Coin')`).run(drop.title);
  } finally {
    scratchDb.close();
  }
  const amount = drop.min === 0 ? drop.max : (drop.min + drop.max) / 2;
  const alone = await connectTo(path);
  try {
    assert.equal(await getGold(alone.client, drop.title), Math.round(10000 * (drop.chance / 100) * amount),
      `${drop.title}'s Crystal Coins alone`);
  } finally {
    await alone.close();
  }
});

test('a 1-104 drop counts its midpoint', async () => {
  // Dragon's Gold Coin drop is stored as 1-104. Alone at a 70% chance it is worth
  // 0.7 x 52.5 = 36.75, so 37. Reading it as its maximum would give 73, and integer
  // division of the midpoint 36.
  const path = join(scratch(), 'midpoint.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  try {
    const coin = db.prepare(
      `select d.min, d.max from creature_drop d join creature c on c.article_id = d.creature_id
        join item i on i.article_id = d.item_id where c.title = 'Dragon' and i.title = 'Gold Coin'`).get();
    assert.deepEqual({ ...coin }, { min: 1, max: 104 }, 'guard: Dragon drops 1-104 Gold Coins');
    db.exec(`delete from creature_drop
      where creature_id = (select article_id from creature where title = 'Dragon')
        and item_id != (select article_id from item where title = 'Gold Coin');
      update creature_drop set chance = 70
      where creature_id = (select article_id from creature where title = 'Dragon')`);
  } finally {
    db.close();
  }
  const h = await connectTo(path);
  try {
    assert.equal(await getGold(h.client, 'Dragon'), 37);
  } finally {
    await h.close();
  }
});

/** Demon's raceId from both tools that report a creature. */
async function demonRaceIds(client: Client): Promise<[unknown, unknown]> {
  const demon = (await findAll(client, { bestiary_class: 'Demon' })).find((c) => c.title === 'Demon');
  assert.ok(demon, 'guard: tibia_find_creatures finds Demon');
  assert.ok('raceId' in demon, 'tibia_find_creatures reports raceId');
  const res = await client.callTool({ name: 'tibia_get', arguments: { name: 'Demon', type: 'creature' } });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const detail = res.structuredContent as Record<string, unknown>;
  assert.ok('raceId' in detail, 'tibia_get reports raceId');
  return [demon.raceId, detail.raceId];
}

test('both tools report a creature\'s race ID', async () => {
  const h = await connect();
  try {
    assert.deepEqual(await demonRaceIds(h.client), [35, 35]);
  } finally {
    await h.close();
  }
});

test('a creature with no recorded race ID reports null in both tools', async () => {
  const path = join(scratch(), 'race-id.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  try {
    db.exec("update creature set race_id = null where title = 'Demon'");
  } finally {
    db.close();
  }
  const h = await connectTo(path);
  try {
    assert.deepEqual(await demonRaceIds(h.client), [null, null]);
  } finally {
    await h.close();
  }
});

test('both tools describe raceId in the same words', async () => {
  const h = await connect();
  try {
    const { tools } = await h.client.listTools();
    const output = (name: string): any => tools.find((t) => t.name === name)!.outputSchema;
    const creature = output('tibia_get').oneOf
      .find((b: any) => b.properties.type.const === 'creature').properties;
    const row = output('tibia_find_creatures').properties.results.items.properties;
    assert.equal(raceIdSchema.description, RACE_ID_MEANING);
    assert.equal(row.raceId.description, RACE_ID_MEANING, 'tibia_find_creatures raceId');
    assert.equal(creature.raceId.description, RACE_ID_MEANING, 'tibia_get raceId');
    assert.equal(RACE_ID_MEANING,
      'Tibia client race ID, not unique: boss phases can share one. null: the wiki records none.');
  } finally {
    await h.close();
  }
});
