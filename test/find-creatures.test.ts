import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { connect, connectTo, FIXTURE, tempDirs, withRealIndex } from './harness.ts';

type Creature = {
  title: string; hitpoints: number | null; experience: number | null;
  bestiaryClass: string | null; modifiers: Record<string, number | null>;
  runsAt: number | null; seesInvisible: boolean | null; paralysable: boolean | null;
  pushable: boolean | null; summonCost: number | null; convinceCost: number | null;
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

test('a result row carries how the creature behaves', async () => {
  const h = await connect();
  try {
    const dragon = (await findAll(h.client, { bestiary_class: 'Dragon' })).find((c) => c.title === 'Dragon');
    assert.ok(dragon, 'guard: Dragon is in the fixture');
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
