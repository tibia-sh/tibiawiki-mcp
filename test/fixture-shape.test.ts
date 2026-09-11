import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { FIXTURE } from './harness.ts';

/**
 * The fixture is the substrate every tool test runs against. Twice in this project a
 * test passed while the thing it guarded was broken, both times because the fixture
 * lacked the rows that would have exposed it. This test names each table explicitly
 * so a future trim cannot silently empty one and leave the suite green.
 */
const REQUIRED_NON_EMPTY = [
  'creature', 'item', 'item_attribute', 'creature_drop', 'npc',
  'npc_offer_sell', 'npc_offer_buy', 'quest', 'quest_reward', 'spell', 'database_info',
  'achievement', 'house', 'imbuement', 'imbuement_material', 'charm', 'mount',
  'outfit', 'outfit_quest', 'book', 'world', 'game_update', 'rashid_position',
  'creature_ability', 'creature_max_damage', 'creature_sound',
  'item_key', 'item_sound', 'item_store_offer', 'item_proficiency_perk',
  'npc_job', 'npc_race', 'npc_destination', 'quest_danger',
] as const;

test('every table the tools read has at least one fixture row', () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  const empty: string[] = [];
  for (const table of REQUIRED_NON_EMPTY) {
    const { c } = db.prepare(`select count(*) c from "${table}"`).get() as { c: number };
    if (c === 0) empty.push(table);
  }
  db.close();
  assert.deepEqual(empty, [], 'these tables are empty, so any test asserting on them passes vacuously');
});

test('the fixture carries the named anchors the detail tests depend on', () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  const count = (sql: string, ...p: string[]) =>
    (db.prepare(sql).get(...p) as { c: number }).c;

  // (creature_id, name) is NOT unique - three rows share 'Poison Ball'. Detail joins
  // must return all three, so the anchor has to be present to prove it.
  assert.equal(count(
    `select count(*) c from creature_ability a join creature c on c.article_id = a.creature_id
     where c.title = ? and a.name = ?`, 'The Plasmother', 'Poison Ball'), 3);

  // item_key is one-to-many; a singular keyInfo with .get() would drop rows.
  assert.ok(count(
    `select count(*) c from item_key k join item i on i.article_id = k.item_id where i.title = ?`,
    'Golden Key') > 1, 'need a multi-key item');

  // The committed fixture had ZERO npc_destination rows before this task.
  assert.ok(count(
    `select count(*) c from npc_destination d join npc n on n.article_id = d.npc_id where n.title = ?`,
    'Captain Bluebear') > 0);

  assert.equal(count('select count(*) c from rashid_position'), 7);
  assert.equal(count(
    `select count(*) c from creature_ability a join creature c on c.article_id = a.creature_id
     where c.title = ?`, 'Dragon'), 4);
  db.close();
});
