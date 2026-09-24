import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { connect, connectTo, FIXTURE, tempDirs, withRealIndex } from './harness.ts';

const scratch = tempDirs('twmcp-find-items-');

type ItemsOut = {
  results: Array<{
    title: string; itemClass: string | null; weight: number | null; clientId: number | null;
    attributes: Record<string, string | number>;
  }>;
  totalMatches: number;
  nextCursor?: string;
};

test('filters items by a numeric EAV attribute', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_items', arguments: { attack_min: 50, limit: 50 },
  });
  const data = res.structuredContent as ItemsOut;
  assert.ok(data.results.length > 0, 'expected matches');
  // Exact count: only two retained items clear this bar, so a regression that
  // narrowed the result to one row would otherwise still pass.
  assert.equal(data.totalMatches, 2, `expected exactly 2, got ${data.totalMatches}`);
  for (const r of data.results) {
    assert.ok(Number(r.attributes.attack) >= 50, `${r.title} attack=${r.attributes.attack}`);
  }
  await h.close();
});

test('numeric comparison is numeric, not lexicographic', async () => {
  // item_attribute.value is TEXT. Without cast(value as integer) a string compare
  // would exclude "55" from ">= 9" because '5' < '9'. This is the guard.
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_items', arguments: { attack_min: 9, limit: 50 },
  });
  const titles = (res.structuredContent as ItemsOut).results.map((r) => r.title);
  assert.ok(titles.includes('Magic Longsword'), `attack 55 must satisfy >= 9; got ${JSON.stringify(titles)}`);
  await h.close();
});

test('finds Magic Longsword by its exact known attributes', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_items',
    arguments: { attack_min: 55, attack_max: 55, required_level_max: 140 },
  });
  const titles = (res.structuredContent as ItemsOut).results.map((r) => r.title);
  assert.ok(titles.includes('Magic Longsword'), `got ${JSON.stringify(titles)}`);
  await h.close();
});

test('text EAV filters match membership, not equality', async () => {
  // required_vocation holds comma-joined plurals, e.g. "monks, druids, sorcerers,
  // paladins, knights". Searching "knight" must match "knights".
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_items', arguments: { vocation: 'knight', limit: 50 },
  });
  const data = res.structuredContent as ItemsOut;
  assert.ok(data.results.length > 0, 'expected vocation matches');
  for (const r of data.results) {
    assert.match(String(r.attributes.required_vocation ?? ''), /knight/i);
  }
  await h.close();
});

test('weapon_type is a text filter too', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_items', arguments: { weapon_type: 'Sword', limit: 50 },
  });
  const data = res.structuredContent as ItemsOut;
  assert.ok(data.results.length > 0);
  for (const r of data.results) {
    assert.match(String(r.attributes.weapon_type ?? ''), /sword/i);
  }
  await h.close();
});

test('item_class is a real column filter and sorting is stable', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_items', arguments: { sort: 'title', limit: 5 },
  });
  const titles = (res.structuredContent as ItemsOut).results.map((r) => r.title);
  assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)));
  await h.close();
});

// The fixture holds 135 items and few of them carry resistances or skill bonuses, so
// the tests below open the real packaged index, the way find-updates.test.ts does.
// They assert stats of long-standing items, which later data releases do not change,
// and membership rather than position.
type Item = ItemsOut['results'][number];

async function find(client: Client, args: Record<string, unknown>): Promise<ItemsOut> {
  const res = await client.callTool({ name: 'tibia_find_items', arguments: args });
  // The server checks structuredContent against the output schema, so a success is
  // also a schema check.
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  return res.structuredContent as ItemsOut;
}

/** Every page of a query, walked through nextCursor. */
async function findAll(client: Client, args: Record<string, unknown>): Promise<Item[]> {
  const all: Item[] = [];
  let cursor: string | undefined;
  do {
    const page = await find(client, { limit: 100, ...args, ...(cursor ? { cursor } : {}) });
    all.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

function byTitle(items: Item[], title: string): Item | undefined {
  return items.find((r) => r.title === title);
}

test('resistant_to keeps items that resist the element, not ones weak to it', () => withRealIndex(async (client) => {
  const items = await findAll(client, { resistant_to: ['fire'] });
  // Magma Coat has resistance_fire 8. Terra Legs carries the attribute too, at -6.
  assert.equal(byTitle(items, 'Magma Coat')?.attributes.resistance_fire, 8);
  assert.equal(byTitle(items, 'Terra Legs'), undefined, 'a negative resistance is a weakness');
  for (const r of items) assert.ok((r.attributes.resistance_fire as number) > 0, `${r.title}`);
}));

test('resistant_to with two elements needs both', () => withRealIndex(async (client) => {
  const items = await findAll(client, { resistant_to: ['fire', 'ice'] });
  const headguard = byTitle(items, 'Alicorn Headguard');
  assert.ok(headguard, 'Alicorn Headguard resists fire 5 and ice 5');
  assert.equal(headguard.attributes.resistance_ice, 5);
  // Magma Coat resists fire 8 but has ice -8. Bonfire Amulet resists fire and has no
  // ice resistance, Crystal Boots resist ice and have no fire resistance.
  assert.equal(byTitle(items, 'Magma Coat'), undefined);
  assert.equal(byTitle(items, 'Bonfire Amulet'), undefined);
  assert.equal(byTitle(items, 'Crystal Boots'), undefined);
}));

test('lifedrain maps to the resistance_life_drain attribute', () => withRealIndex(async (client) => {
  const items = await findAll(client, { resistant_to: ['lifedrain'] });
  assert.equal(byTitle(items, 'Garlic Necklace')?.attributes.resistance_life_drain, 20);
  // Depth Galea resists drowning only.
  assert.equal(byTitle(items, 'Depth Galea'), undefined);
  const drown = await findAll(client, { resistant_to: ['drown'] });
  assert.equal(byTitle(drown, 'Depth Galea')?.attributes.resistance_drowning, 100);
}));

test('manadrain and critical_hit map to their resistance attributes', () => withRealIndex(async (client) => {
  const drain = await findAll(client, { resistant_to: ['manadrain'] });
  assert.equal(byTitle(drain, 'Bronze Amulet')?.attributes.resistance_mana_drain, 20);
  // Garlic Necklace resists life drain only.
  assert.equal(byTitle(drain, 'Garlic Necklace'), undefined);
  for (const r of drain) assert.ok((r.attributes.resistance_mana_drain as number) > 0, `${r.title}`);
  const critical = await findAll(client, { resistant_to: ['critical_hit'] });
  assert.equal(byTitle(critical, 'Cursed Coin')?.attributes.resistance_critical_hit_chance, 1);
  assert.equal(byTitle(critical, 'Bronze Amulet'), undefined);
  for (const r of critical) assert.ok((r.attributes.resistance_critical_hit_chance as number) > 0, `${r.title}`);
}));

test('tibia_get reports signed resistances and skill bonuses as numbers', () => withRealIndex(async (client) => {
  const legs = await client.callTool({ name: 'tibia_get', arguments: { name: 'Terra Legs' } });
  assert.equal((legs.structuredContent as any).attributes.resistance_fire, -6);
  const book = await client.callTool({
    name: 'tibia_get', arguments: { name: 'Spellbook of Mind Control' },
  });
  assert.equal((book.structuredContent as any).attributes.magic_level, 2);
}));

test('healing is not an item resistance', () => withRealIndex(async (client) => {
  const res = await client.callTool({
    name: 'tibia_find_items', arguments: { resistant_to: ['healing'] },
  });
  assert.equal(res.isError, true, 'no item resists healing, so the input refuses it');
}));

test('skill_bonus with a vocation finds magic level items for sorcerers', () => withRealIndex(async (client) => {
  const items = await findAll(client, { skill_bonus: ['magic_level'], vocation: 'sorcerer' });
  assert.equal(byTitle(items, 'Spellbook of Mind Control')?.attributes.magic_level, 2);
  // Amber Rod gives magic level to druids only, Magma Coat is for sorcerers without it.
  assert.equal(byTitle(items, 'Amber Rod'), undefined);
  assert.equal(byTitle(items, 'Magma Coat'), undefined);
}));

test('skill_bonus with two skills needs both', () => withRealIndex(async (client) => {
  const items = await findAll(client, { skill_bonus: ['sword', 'axe'] });
  const greaves = byTitle(items, 'Falcon Greaves');
  assert.ok(greaves, 'Falcon Greaves gives sword, axe and club');
  assert.equal(greaves.attributes.sword, 3);
  assert.equal(greaves.attributes.axe, 3);
  // Ectoplasmic Shield gives axe and club but no sword, Earthheart Cuirass sword but no axe.
  assert.equal(byTitle(items, 'Ectoplasmic Shield'), undefined);
  assert.equal(byTitle(items, 'Earthheart Cuirass'), undefined);
}));

test('imbuement_slots_min keeps items with at least that many slots', () => withRealIndex(async (client) => {
  const items = await findAll(client, { imbuement_slots_min: 3 });
  assert.equal(byTitle(items, 'Giant Sword')?.attributes.imbuement_slots, 3);
  // Blue Robe has two.
  assert.equal(byTitle(items, 'Blue Robe'), undefined);
}));

test('weight_max includes the boundary and excludes items without a weight', () => withRealIndex(async (client) => {
  // Magma Legs weigh 19.0 and Magma Coat 22.5.
  const at = await findAll(client, { weight_max: 19, vocation: 'sorcerer', armor_min: 8 });
  assert.equal(byTitle(at, 'Magma Legs')?.weight, 19);
  assert.equal(byTitle(at, 'Magma Coat'), undefined);
  for (const r of at) assert.ok(r.weight !== null && r.weight <= 19, `${r.title} weighs ${r.weight}`);
  const below = await findAll(client, { weight_max: 18.9, vocation: 'sorcerer', armor_min: 8 });
  assert.equal(byTitle(below, 'Magma Legs'), undefined);
  // Utilities such as Mailbox record no weight, so a weight cap drops them.
  const utilities = await find(client, { item_class: 'Utilities', limit: 100 });
  assert.ok(utilities.totalMatches > 0);
  const capped = await find(client, { item_class: 'Utilities', weight_max: 100000, limit: 100 });
  assert.ok(capped.totalMatches < utilities.totalMatches);
  for (const r of capped.results) assert.ok(r.weight !== null, `${r.title} has no weight`);
}));

test('hands filters one-handed from two-handed weapons', () => withRealIndex(async (client) => {
  const items = await findAll(client, { hands: 'one', weapon_type: 'Sword' });
  assert.equal(byTitle(items, 'Amber Sabre')?.attributes.hands, 'One');
  assert.equal(byTitle(items, 'Giant Sword'), undefined, 'Giant Sword is two-handed');
  for (const r of items) assert.equal(r.attributes.hands, 'One', r.title);
}));

test('hands two finds two-handed weapons and no one-handed ones', () => withRealIndex(async (client) => {
  const items = await findAll(client, { hands: 'two', weapon_type: 'Sword' });
  assert.equal(byTitle(items, 'Giant Sword')?.attributes.hands, 'Two');
  assert.equal(byTitle(items, 'Amber Sabre'), undefined, 'Amber Sabre is one-handed');
  for (const r of items) assert.equal(r.attributes.hands, 'Two', r.title);
}));

/** The fold SQLite's NOCASE applies: ASCII letters only. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Descending by the stat's leading integer, items without it last, ties by title. */
function assertStatOrder(items: Item[], stat: string): void {
  const value = (r: Item): number | null =>
    r.attributes[stat] === undefined ? null : Number.parseInt(String(r.attributes[stat]), 10);
  const firstNull = items.findIndex((r) => value(r) === null);
  if (firstNull >= 0) {
    assert.ok(items.slice(firstNull).every((r) => value(r) === null), `no ${stat} after the first null`);
  }
  items.slice(1).forEach((b, k) => {
    const a = items[k] as Item;
    const [x, y] = [value(a), value(b)];
    if (x !== null && y === null) return;
    assert.ok(x === null || y === null || x >= y, `${a.title} (${x}) before ${b.title} (${y})`);
    if (x === y) assert.ok(asciiLower(a.title) < asciiLower(b.title), `${a.title} before ${b.title}`);
  });
}

test('sort armor is descending, nulls last, ties by title', () => withRealIndex(async (client) => {
  const items = await findAll(client, { vocation: 'knight', sort: 'armor' });
  assert.ok(byTitle(items, 'Norcferatu Tuskplate'), 'a knight armor');
  assert.ok(byTitle(items, 'Giant Sword'), 'a knight weapon without armor');
  assert.notEqual(items[0]?.attributes.armor, undefined, 'items with armor come first');
  assertStatOrder(items, 'armor');
}));

test('sort defense ranks a suffixed value by its leading integer', () => withRealIndex(async (client) => {
  const items = await findAll(client, { weapon_type: 'Axe', sort: 'defense' });
  assert.equal(byTitle(items, 'Moonsilver Axe')?.attributes.defense, '33 +3');
  assertStatOrder(items, 'defense');
}));

test('an item with two rows for a stat sorts by the larger', async () => {
  // No item has two armor rows today, but the filters accept any row, so the sort
  // must read one value per item that does not depend on row order. Devil Helmet has
  // armor 7 in the fixture, and a second row of 99 puts it above Magic Plate Armor (17).
  const path = join(scratch(), 'index.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  db.prepare(
    `insert into item_attribute (item_id, name, value)
       select article_id, 'armor', '99' from item where title = 'Devil Helmet'`,
  ).run();
  db.close();
  const h = await connectTo(path);
  try {
    const data = await find(h.client, { sort: 'armor', limit: 1 });
    assert.equal(data.results[0]?.title, 'Devil Helmet');
  } finally {
    await h.close();
  }
});

/** A client on the fixture for one test. */
async function onFixture(fn: (client: Client) => Promise<void>): Promise<void> {
  const h = await connect();
  try {
    await fn(h.client);
  } finally {
    await h.close();
  }
}

test('client_ids keeps exactly the items holding a listed ID', () => onFixture(async (client) => {
  const data = await find(client, { client_ids: [3031, 3035] });
  assert.deepEqual(
    data.results.map((r) => [r.title, r.clientId]),
    [['Gold Coin', 3031], ['Platinum Coin', 3035]],
  );
  assert.equal(data.totalMatches, 2);
}));

test('client_ids narrows together with another filter', () => onFixture(async (client) => {
  const shields = await find(client, { client_ids: [3031, 3416], item_type: 'Shields' });
  assert.deepEqual(shields.results.map((r) => r.title), ['Dragon Shield']);
  const valuables = await find(client, { client_ids: [3416], item_type: 'Valuables' });
  assert.equal(valuables.totalMatches, 0, 'Dragon Shield is not a valuable');
}));

test('an ID no item holds gives an empty result, not an error', () => onFixture(async (client) => {
  const data = await find(client, { client_ids: [999999999] });
  assert.equal(data.totalMatches, 0);
  assert.deepEqual(data.results, []);
}));

test('client_ids leaves out inactive items unless include_inactive is set', () => onFixture(async (client) => {
  // Arrow (Weak) is ts-only.
  assert.equal((await find(client, { client_ids: [22043] })).totalMatches, 0);
  const all = await find(client, { client_ids: [22043], include_inactive: true });
  assert.deepEqual(all.results.map((r) => [r.title, r.clientId]), [['Arrow (Weak)', 22043]]);
}));

test('an item without a client ID reports null and no ID finds it', () => onFixture(async (client) => {
  const liquids = await find(client, { item_type: 'Liquids', limit: 100 });
  const mud = byTitle(liquids.results, 'Mud');
  assert.ok(mud, 'Mud is a liquid in the fixture');
  assert.equal(mud.clientId, null);
  const ids = liquids.results.flatMap((r) => (r.clientId === null ? [] : [r.clientId]));
  assert.ok(ids.length > 0, 'the other liquids have client IDs');
  const found = await find(client, { client_ids: ids, item_type: 'Liquids', limit: 100 });
  assert.equal(found.totalMatches, liquids.totalMatches - 1);
  assert.equal(byTitle(found.results, 'Mud'), undefined);
}));

test('client_ids refuses an empty list, a non-positive ID and more than 100 IDs', () => onFixture(async (client) => {
  const ids = Array.from({ length: 101 }, (_, k) => k + 1);
  for (const client_ids of [[], [0], [-3031], [3031.5], ids]) {
    const res = await client.callTool({ name: 'tibia_find_items', arguments: { client_ids } });
    assert.equal(res.isError, true, `${JSON.stringify(client_ids).slice(0, 40)} must be refused`);
  }
}));

test('an ID two item variants share returns every variant', () => withRealIndex(async (client) => {
  const data = await find(client, { client_ids: [281], limit: 100 });
  const titles = data.results.map((r) => r.title);
  assert.ok(titles.includes('Giant Shimmering Pearl'), `got ${JSON.stringify(titles)}`);
  assert.ok(titles.includes('Giant Shimmering Pearl (Green)'), `got ${JSON.stringify(titles)}`);
  for (const r of data.results) assert.equal(r.clientId, 281, r.title);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const expected = db.prepare(
      "select title from item where client_id = 281 and status = 'active' order by title",
    ).all().map((row) => String(row.title));
    assert.deepEqual([...titles].sort(), [...expected].sort());
  } finally {
    db.close();
  }
}));
