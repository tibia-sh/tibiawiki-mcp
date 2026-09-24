import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ELEMENTS, modifierColumn, WEAK_TO, RESISTANT_TO, entityTable,
  creatureSort, itemSort, spellSort, questSort, houseSort, vocationColumn, eavOperator, statusClause,
  ITEM_RESISTANCES, resistanceAttribute,
  DETAILED_CREATURE_FIELDS, DETAILED_ITEM_FIELDS, BEST_GOLD_PRICE,
} from '../src/domain.ts';
import { encodeCursor, decodeCursor } from '../src/cursor.ts';

const FIXTURE = new URL('./fixtures/tibiawiki-fixture.db', import.meta.url).pathname;

test('every element maps to its modifier column', () => {
  assert.equal(ELEMENTS.length, 10);
  assert.equal(modifierColumn('fire'), 'modifier_fire');
  assert.equal(modifierColumn('lifedrain'), 'modifier_lifedrain');
});

test('items resist every element but healing, mana drain and critical hits, under the wiki names', () => {
  assert.deepEqual(
    [...ITEM_RESISTANCES],
    [...ELEMENTS.filter((e) => e !== 'healing'), 'manadrain', 'critical_hit'],
  );
  assert.equal(resistanceAttribute('fire'), 'resistance_fire');
  assert.equal(resistanceAttribute('manadrain'), 'resistance_mana_drain');
  assert.equal(resistanceAttribute('critical_hit'), 'resistance_critical_hit_chance');
  assert.equal(resistanceAttribute('lifedrain'), 'resistance_life_drain');
  assert.equal(resistanceAttribute('drown'), 'resistance_drowning');
});

test('the modifier convention is encoded once: >100 is weak, <100 is resistant', () => {
  assert.equal(WEAK_TO('modifier_fire'), 'modifier_fire > 100');
  assert.equal(RESISTANT_TO('modifier_fire'), 'modifier_fire < 100');
});

// Every string this module returns is interpolated into SQL. Each map must reject
// an out-of-enum key rather than pass it through - one negative test per map.
test('all ten SQL-fragment maps reject unknown keys', () => {
  assert.throws(() => modifierColumn('lava' as never), /unknown element/i);
  assert.throws(() => entityTable('dragon' as never), /unknown entity type/i);
  assert.throws(() => creatureSort('rowid' as never), /unknown sort/i);
  assert.throws(() => itemSort('rowid' as never), /unknown sort/i);
  assert.throws(() => spellSort('rowid' as never), /unknown sort/i);
  assert.throws(() => questSort('rowid' as never), /unknown sort/i);
  assert.throws(() => houseSort('rowid' as never), /unknown sort/i);
  assert.throws(() => vocationColumn('mage' as never), /unknown vocation/i);
  assert.throws(() => eavOperator('drop' as never), /unknown operator/i);
  assert.throws(() => resistanceAttribute('healing' as never), /unknown element/i);
});

test('the maps also reject inherited prototype names', () => {
  // A plain-object lookup resolves these to Object.prototype members, which are
  // truthy and would sail past a `if (!value)` guard into an SQL fragment. The
  // original negative test used 'dragon'/'rowid' and passed while this was broken.
  for (const evil of ['toString', 'constructor', 'valueOf', '__proto__'] as const) {
    assert.throws(() => entityTable(evil as never), /unknown entity type/i, `entityTable(${evil})`);
    assert.throws(() => creatureSort(evil as never), /unknown sort/i, `creatureSort(${evil})`);
    assert.throws(() => itemSort(evil as never), /unknown sort/i, `itemSort(${evil})`);
    assert.throws(() => spellSort(evil as never), /unknown sort/i, `spellSort(${evil})`);
    assert.throws(() => questSort(evil as never), /unknown sort/i, `questSort(${evil})`);
    assert.throws(() => houseSort(evil as never), /unknown sort/i, `houseSort(${evil})`);
    assert.throws(() => vocationColumn(evil as never), /unknown vocation/i, `vocationColumn(${evil})`);
    assert.throws(() => eavOperator(evil as never), /unknown operator/i, `eavOperator(${evil})`);
    assert.throws(() => modifierColumn(evil as never), /unknown element/i, `modifierColumn(${evil})`);
    assert.throws(() => resistanceAttribute(evil as never), /unknown element/i, `resistanceAttribute(${evil})`);
  }
});

test('entityTable maps entity types to real table names', () => {
  assert.equal(entityTable('creature'), 'creature');
  assert.equal(entityTable('npc'), 'npc');
});

test('statusClause is alias-qualified, because every query joins two status columns', () => {
  assert.equal(statusClause('c', false), "c.status = 'active'");
  assert.equal(statusClause('i', false), "i.status = 'active'");
  assert.equal(statusClause('c', true), '');
});

test('an unqualified status predicate really is ambiguous in our joins', () => {
  // Guards the contract above: this is the exact failure statusClause prevents.
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  assert.throws(
    () => db.prepare(`select n.title from npc_offer_sell o
      join npc n on n.article_id = o.npc_id
      join item i on i.article_id = o.item_id
      where status = 'active'`).all(),
    /ambiguous column name/,
  );
  db.close();
});

test('cursor round-trips, defaults to 0, and rejects garbage', () => {
  assert.equal(decodeCursor(encodeCursor(120)), 120);
  assert.equal(decodeCursor(encodeCursor(0)), 0);
  assert.equal(decodeCursor(undefined), 0);
  assert.throws(() => decodeCursor('not-a-cursor'), /cursor/i);
});

test('every detailed field names a column that actually exists', () => {
  // The round-1 gate caught five invented column names. This is the regression guard.
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  const cols = (t: string) =>
    new Set(db.prepare(`pragma table_info("${t}")`).all().map((r) => String(r.name)));
  const creature = cols('creature');
  for (const f of DETAILED_CREATURE_FIELDS) {
    assert.ok(creature.has(f), `creature.${f} does not exist`);
  }
  const item = cols('item');
  for (const f of DETAILED_ITEM_FIELDS) {
    assert.ok(item.has(f), `item.${f} does not exist`);
  }
  db.close();
});

test('BEST_GOLD_PRICE names one active Gold Coin buyer per item, ties by NPC title', () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  try {
    const rows = db.prepare(
      `select i.title as item, n.title as npc, b.price from (${BEST_GOLD_PRICE}) b
         join item i on i.article_id = b.item_id join npc n on n.article_id = b.npc_id`,
    ).all() as Array<{ item: string; npc: string; price: number }>;
    assert.equal(new Set(rows.map((r) => r.item)).size, rows.length, 'one row per item');
    // Written apart from the definition: the highest active Gold Coin offer per item.
    const best = db.prepare(
      `select i.title as item, max(o.value) as price from npc_offer_buy o
         join npc n on n.article_id = o.npc_id join item i on i.article_id = o.item_id
         join item cur on cur.article_id = o.currency_id
        where n.status = 'active' and cur.title = 'Gold Coin' group by o.item_id`,
    ).all() as Array<{ item: string; price: number }>;
    assert.ok(best.length > 0, 'guard: the fixture holds active Gold Coin offers');
    assert.deepEqual(
      Object.fromEntries(rows.map((r) => [r.item, r.price])),
      Object.fromEntries(best.map((r) => [r.item, r.price])),
    );
    // Inigo and Grizzly Adams both pay 55 for a Cyclops Toe, and Yasir, an event NPC, too.
    assert.deepEqual(
      rows.filter((r) => r.item === 'Cyclops Toe').map((r) => ({ ...r })),
      [{ item: 'Cyclops Toe', npc: 'Grizzly Adams', price: 55 }],
    );
    // Only Yasir buys it.
    assert.ok(!rows.some((r) => r.item === "The Plasmother's Remains"), 'an inactive buyer is no buyer');
  } finally {
    db.close();
  }
});
