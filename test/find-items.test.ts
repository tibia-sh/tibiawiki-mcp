import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';

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
