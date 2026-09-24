import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { connect, connectTo, FIXTURE, tempDirs, withRealIndex } from './harness.ts';

const scratch = tempDirs('twmcp-find-items-');

type ItemsOut = {
  results: Array<{
    title: string; itemClass: string | null; weight: number | null;
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
  assert.equal(byTitle(items, 'Magma Coat')?.attributes.resistance_fire, '8');
  assert.equal(byTitle(items, 'Terra Legs'), undefined, 'a negative resistance is a weakness');
  for (const r of items) assert.ok(Number(r.attributes.resistance_fire) > 0, `${r.title}`);
}));

test('resistant_to with two elements needs both', () => withRealIndex(async (client) => {
  const items = await findAll(client, { resistant_to: ['fire', 'ice'] });
  const headguard = byTitle(items, 'Alicorn Headguard');
  assert.ok(headguard, 'Alicorn Headguard resists fire 5 and ice 5');
  assert.equal(headguard.attributes.resistance_ice, '5');
  // Magma Coat resists fire 8 but has ice -8. Bonfire Amulet resists fire and has no
  // ice resistance, Crystal Boots resist ice and have no fire resistance.
  assert.equal(byTitle(items, 'Magma Coat'), undefined);
  assert.equal(byTitle(items, 'Bonfire Amulet'), undefined);
  assert.equal(byTitle(items, 'Crystal Boots'), undefined);
}));

test('lifedrain maps to the resistance_life_drain attribute', () => withRealIndex(async (client) => {
  const items = await findAll(client, { resistant_to: ['lifedrain'] });
  assert.equal(byTitle(items, 'Garlic Necklace')?.attributes.resistance_life_drain, '20');
  // Depth Galea resists drowning only.
  assert.equal(byTitle(items, 'Depth Galea'), undefined);
  const drown = await findAll(client, { resistant_to: ['drown'] });
  assert.equal(byTitle(drown, 'Depth Galea')?.attributes.resistance_drowning, '100');
}));

test('healing is not an item resistance', () => withRealIndex(async (client) => {
  const res = await client.callTool({
    name: 'tibia_find_items', arguments: { resistant_to: ['healing'] },
  });
  assert.equal(res.isError, true, 'no item resists healing, so the input refuses it');
}));

test('skill_bonus with a vocation finds magic level items for sorcerers', () => withRealIndex(async (client) => {
  const items = await findAll(client, { skill_bonus: ['magic_level'], vocation: 'sorcerer' });
  assert.equal(byTitle(items, 'Spellbook of Mind Control')?.attributes.magic_level, '+2');
  // Amber Rod gives magic level to druids only, Magma Coat is for sorcerers without it.
  assert.equal(byTitle(items, 'Amber Rod'), undefined);
  assert.equal(byTitle(items, 'Magma Coat'), undefined);
}));

test('skill_bonus with two skills needs both', () => withRealIndex(async (client) => {
  const items = await findAll(client, { skill_bonus: ['sword', 'axe'] });
  const greaves = byTitle(items, 'Falcon Greaves');
  assert.ok(greaves, 'Falcon Greaves gives sword, axe and club');
  assert.equal(greaves.attributes.sword, '+3');
  assert.equal(greaves.attributes.axe, '+3');
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
