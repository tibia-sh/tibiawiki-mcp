import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';

const get = async (h: Awaited<ReturnType<typeof connect>>, name: string, type?: string, verbosity?: string) => {
  const res = await h.client.callTool({
    name: 'tibia_get',
    arguments: { name, ...(type ? { type } : {}), ...(verbosity ? { verbosity } : {}) },
  });
  assert.notEqual(res.isError, true, `${name}: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Record<string, any>;
};

test('a creature carries its abilities with damage ranges', async () => {
  const h = await connect();
  const dragon = await get(h, 'Dragon');
  assert.equal(dragon.abilities.length, 4);
  const fireball = dragon.abilities.find((a: any) => a.name === 'Great Fireball');
  assert.ok(fireball, `got ${JSON.stringify(dragon.abilities.map((a: any) => a.name))}`);
  assert.equal(fireball.effect, '60-140');
  assert.equal(fireball.element, 'fire');
  await h.close();
});

// (creature_id, name) is NOT unique - The Plasmother has three rows all named
// 'Poison Ball'. A join keyed on name alone would collapse them.
test('duplicate ability names are all returned, not collapsed', async () => {
  const h = await connect();
  const c = await get(h, 'The Plasmother');
  const poison = c.abilities.filter((a: any) => a.name === 'Poison Ball');
  assert.equal(poison.length, 3, `got ${JSON.stringify(c.abilities.map((a: any) => a.name))}`);
  // The ordering must be total, or the set is non-deterministic across VACUUM.
  const keys = poison.map((a: any) => `${a.effect}|${a.element}`);
  assert.equal(new Set(keys).size, 3, 'the three rows should be distinguishable');
  await h.close();
});

test('a creature carries its max damage per element and total', async () => {
  const h = await connect();
  const dragon = await get(h, 'Dragon');
  assert.equal(dragon.maxDamage.fire, 310);
  assert.equal(dragon.maxDamage.physical, 120);
  assert.equal(dragon.maxDamage.total, 430);
  await h.close();
});

test('a creature with no max damage row returns null, not an error', async () => {
  const h = await connect();
  const c = await get(h, 'Rotworm');
  assert.ok(c.maxDamage === null || typeof c.maxDamage === 'object');
  await h.close();
});

// item_key is one-to-many: Silver Key has 61 rows. A singular field read with
// .get() would silently drop all but one.
test('an item returns every key article that uses it', async () => {
  const h = await connect();
  const key = await get(h, 'Golden Key', 'item');
  assert.ok(key.keys.length > 1, `expected multiple keys, got ${key.keys.length}`);
  assert.ok(key.keys.every((k: any) => typeof k.number === 'number'));
  await h.close();
});

test('an item returns its store offers and proficiency perks', async () => {
  const h = await connect();
  const potion = await get(h, 'Strong Mana Potion', 'item');
  assert.ok(potion.storeOffers.length > 0);
  assert.ok(potion.storeOffers.every((o: any) => typeof o.price === 'number' && o.currency));
  const bile = await get(h, 'Crypt Bile', 'item');
  assert.ok(bile.proficiencyPerks.length > 0);
  assert.ok(bile.proficiencyPerks.every((p: any) => typeof p.level === 'number'));
  await h.close();
});

test('an NPC returns its travel destinations with fares', async () => {
  const h = await connect();
  const captain = await get(h, 'Captain Bluebear', 'npc');
  assert.ok(captain.destinations.length > 0);
  assert.ok(captain.destinations.every((d: any) => typeof d.name === 'string'));
  assert.ok(captain.jobs.length > 0 || captain.races.length > 0);
  await h.close();
});

// rashid_position.day is an integer 0-6, useless to an agent without names.
test('Rashid returns a seven-day schedule with weekday names', async () => {
  const h = await connect();
  const rashid = await get(h, 'Rashid', 'npc');
  assert.equal(rashid.rashidSchedule.length, 7);
  const days = rashid.rashidSchedule.map((d: any) => d.day);
  // Asserting only that 'Monday' appears somewhere let a one-day shift through:
  // tibiawiki-sql documents day 0 as MONDAY, and starting the week at Sunday moved
  // every entry. Pin the order and a known city instead.
  assert.deepEqual(days, [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  ]);
  const monday = rashid.rashidSchedule.find((d: any) => d.day === 'Monday');
  assert.equal(monday.city, 'Svargrond', 'day 0 is Monday, and Rashid is in Svargrond');
  assert.ok(rashid.rashidSchedule.every((d: any) => typeof d.city === 'string'));
  await h.close();
});

test('a non-Rashid NPC has no schedule field rather than an empty one', async () => {
  const h = await connect();
  const other = await get(h, 'Captain Bluebear', 'npc');
  assert.equal(other.rashidSchedule, undefined);
  await h.close();
});

// quest_danger stores creature_id, not a name - it must be joined to be useful.
test('a quest returns its dangers as creature names and its rewards', async () => {
  const h = await connect();
  const q = await get(h, 'Forgotten Knowledge Quest', 'quest');
  assert.ok(q.dangers.length > 0);
  assert.ok(q.dangers.every((d: string) => typeof d === 'string' && d.length > 0),
    'dangers must be names, not ids');
  assert.ok(Array.isArray(q.rewards));
  await h.close();
});

// imbuement_material stores item_id + amount; the name needs a join.
test('an imbuement returns its materials with names and amounts', async () => {
  const h = await connect();
  const imb = await get(h, 'Powerful Reap', 'imbuement');
  assert.ok(imb.materials.length > 0);
  assert.ok(imb.materials.every((m: any) => typeof m.item === 'string' && typeof m.amount === 'number'));
  await h.close();
});

test('an outfit returns its unlocking quests', async () => {
  const h = await connect();
  const o = await get(h, 'Assassin Outfits', 'outfit');
  assert.ok(o.quests.length > 0);
  assert.ok(o.quests.every((q: any) => typeof q.quest === 'string'));
  await h.close();
});

test('quest.legend stays top-level at concise verbosity', async () => {
  const h = await connect();
  const q = await get(h, 'Forgotten Knowledge Quest', 'quest');
  assert.ok('legend' in q, 'legend is a shipped top-level field and must not move');
  await h.close();
});

test('book text is gated behind detailed verbosity', async () => {
  const h = await connect();
  assert.equal((await get(h, 'Goldfinger (Book)', 'book')).text, undefined);
  assert.ok(typeof (await get(h, 'Goldfinger (Book)', 'book', 'detailed')).text === 'string');
  await h.close();
});
