import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';
import { ENTITY_TYPES, entityTable, entityHasStatus } from '../src/domain.ts';

/** One real anchor per new type, all retained by the fixture. */
const ANCHORS = {
  achievement: 'Backpack Tourist',
  house: "Warriors' Guildhall",
  imbuement: 'Powerful Reap',
  charm: 'Adrenaline Burst',
  mount: 'Donkey',
  outfit: 'Assassin Outfits',
  book: 'Goldfinger (Book)',
  world: 'Antica',
  update: 'Updates/7.9',
} as const;

test('there are fourteen entity types and the maps cover every one', () => {
  assert.equal(ENTITY_TYPES.length, 14);
  for (const t of ENTITY_TYPES) {
    assert.ok(entityTable(t).length > 0, `${t} has no table`);
    assert.equal(typeof entityHasStatus(t), 'boolean');
  }
});

test('only world and update lack a status column', () => {
  const without = ENTITY_TYPES.filter((t) => !entityHasStatus(t));
  assert.deepEqual([...without].sort(), ['update', 'world']);
});

test('the entity maps reject unknown keys and inherited prototype names', () => {
  for (const evil of ['nope', 'toString', 'constructor', 'valueOf', '__proto__'] as const) {
    assert.throws(() => entityTable(evil as never), /unknown entity type/i, `entityTable(${evil})`);
    assert.throws(() => entityHasStatus(evil as never), /unknown entity type/i, `entityHasStatus(${evil})`);
  }
});

test('tibia_search finds every new entity type', async () => {
  const h = await connect();
  for (const [type, title] of Object.entries(ANCHORS)) {
    const res = await h.client.callTool({
      name: 'tibia_search', arguments: { query: title, types: [type], limit: 5 },
    });
    const data = res.structuredContent as { results: Array<{ title: string; type: string }> };
    assert.ok(data.results.length > 0, `no ${type} results for ${title}`);
    assert.ok(data.results.some((r) => r.title === title), `${type}: ${title} not found`);
  }
  await h.close();
});

test('tibia_get returns the right discriminated member for every new type', async () => {
  const h = await connect();
  for (const [type, title] of Object.entries(ANCHORS)) {
    const res = await h.client.callTool({
      name: 'tibia_get', arguments: { name: title, type },
    });
    assert.notEqual(res.isError, true, `${type} ${title}: ${JSON.stringify(res.content)}`);
    const data = res.structuredContent as Record<string, unknown>;
    assert.equal(data.type, type);
    assert.equal(data.title, title);
    assert.ok(data.source, `${type} has no source block`);
  }
  await h.close();
});

// world and game_update have no `status` column. Both tools applied statusClause
// unconditionally, which raises `no such column: t.status` — search prepares its
// statements eagerly, so that would have failed at server construction.
test('status-less types resolve under both include_inactive values', async () => {
  const h = await connect();
  for (const type of ['world', 'update'] as const) {
    for (const include_inactive of [false, true]) {
      const res = await h.client.callTool({
        name: 'tibia_get',
        arguments: { name: ANCHORS[type], type, include_inactive },
      });
      assert.notEqual(res.isError, true,
        `${type} include_inactive=${include_inactive}: ${JSON.stringify(res.content)}`);
    }
    const s = await h.client.callTool({
      name: 'tibia_search', arguments: { query: 'a', types: [type], include_inactive: true, limit: 5 },
    });
    assert.notEqual(s.isError, true, `search ${type} with include_inactive`);
  }
  await h.close();
});

test('known answers guard against silent column drift', async () => {
  const h = await connect();
  const get = async (name: string, type: string) =>
    (await h.client.callTool({ name: 'tibia_get', arguments: { name, type } }))
      .structuredContent as Record<string, any>;

  assert.equal((await get("Warriors' Guildhall", 'house')).rent, 5000000);
  assert.equal((await get("Warriors' Guildhall", 'house')).city, 'Thais');
  assert.equal((await get('Updates/7.9', 'update')).releaseDate, '2006-12-12');
  assert.equal((await get('Powerful Reap', 'imbuement')).tier, 'Powerful');
  // slots is a category list, not a count — the column is TEXT like "axes,clubs".
  const reap = await get('Powerful Reap', 'imbuement');
  assert.ok(Array.isArray(reap.slots) && reap.slots.length > 0, 'slots should be a non-empty list');
  assert.ok(reap.slots.every((x: unknown) => typeof x === 'string'));
  await h.close();
});
