import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import {
  ELEMENTS, modifierColumn, WEAK_TO, RESISTANT_TO, entityTable,
  creatureSort, itemSort, spellSort, questSort, houseSort, vocationColumn, eavOperator, statusClause,
  ITEM_RESISTANCES, resistanceAttribute,
  DETAILED_CREATURE_FIELDS, DETAILED_ITEM_FIELDS, BEST_GOLD_PRICE, resolveItemName, asciiLower,
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

/** The titles `resolveItemName` settles on, for a database it opens and closes. */
type Titles = (name: string, opts?: Parameters<typeof resolveItemName>[2]) => string[];
function resolving(path: string, fn: (titles: Titles, db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    fn((name, opts) => resolveItemName(db, name, opts).map((r) => r.title), db);
  } finally {
    db.close();
  }
}

/** The article id of each creature titled so, asserting every one is found. */
function creatureIds(db: DatabaseSync, ...titles: string[]): Set<number> {
  const byTitle = db.prepare('select article_id from creature where title = ?');
  const ids = titles.map((t) => byTitle.get(t)?.article_id);
  assert.ok(ids.every((id) => id !== undefined), `guard: the index holds ${titles.join(', ')}`);
  return new Set(ids.map(Number));
}

test('an exact title resolves in any case, whatever the item status', () => {
  resolving(FIXTURE, (titles, db) => {
    assert.deepEqual(titles('dragon shield'), ['Dragon Shield']);
    const row = db.prepare(`select status from item where title = 'Arrow (Weak)'`).get();
    assert.notEqual(row?.status, 'active', 'guard: Arrow (Weak) is not active');
    assert.deepEqual(titles('ARROW (WEAK)'), ['Arrow (Weak)']);
  });
});

test('the name and plural the game prints resolve to their item', () => {
  resolving(FIXTURE, (titles) => {
    assert.deepEqual(titles('amber'), ['Amber (Item)']);
    assert.deepEqual(titles('small rubies'), ['Small Ruby']);
    assert.deepEqual(titles('small rubies', { count: 2 }), ['Small Ruby']);
  });
  resolving(DB_PATH, (titles) => {
    assert.deepEqual(titles('vial of lifefluid'), ['Lifefluid']);
    assert.deepEqual(titles('vials of lifefluid', { count: 2 }), ['Lifefluid']);
  });
});

// Review Focus 3: plurals the index does not record.
test('a counted plural the index does not record resolves through English plural rules', () => {
  resolving(FIXTURE, (titles, db) => {
    const plurals = db.prepare(
      `select plural from item where title in ('Gold Coin', 'Green Dragon Scale')`).all();
    assert.deepEqual(plurals.map((r) => r.plural), [null, null], 'guard: no plural recorded');
    assert.deepEqual(titles('gold coins', { count: 26 }), ['Gold Coin']);
    assert.deepEqual(titles('Gold Coins', { count: 100 }), ['Gold Coin']);
    assert.deepEqual(titles('green dragon scales', { count: 3 }), ['Green Dragon Scale']);
  });
  resolving(DB_PATH, (titles, db) => {
    const plural = (title: string) =>
      db.prepare('select plural from item where title = ?').get(title)?.plural;
    assert.equal(plural('Brown Piece of Cloth'), null, 'guard: no plural recorded');
    assert.deepEqual(titles('brown pieces of cloth', { count: 2 }), ['Brown Piece of Cloth']);
    assert.equal(plural('Blue Piece of Cloth'), 'blue pieces of cloth', 'guard: plural recorded');
    assert.deepEqual(titles('blue pieces of cloth', { count: 2 }), ['Blue Piece of Cloth']);
  });
});

test('every singular form is tried, on the word before " of " or else the last word', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`create table item (article_id integer primary key, title text collate nocase,
               actual_name text, plural text, status text, is_stackable integer);
             create table creature_drop (creature_id integer, item_id integer);
             insert into item values
               (1, 'Stampor Hoof', 'stampor hoof', null, 'active', 1),
               (2, 'Kitchen Knife', 'kitchen knife', null, 'active', 1),
               (3, 'Blueberry (Item)', 'blue berry', null, 'active', 1),
               (4, 'Wooden Box', 'wooden box', null, 'active', 1),
               (5, 'Frosty Ear of a Troll', 'frosty ear of a troll', null, 'active', 1),
               (6, 'Stone (Event)', 'stone', null, 'event', 1);`);
    const titles = (name: string) => resolveItemName(db, name, { count: 2 }).map((r) => r.title);
    assert.deepEqual(titles('stampor hooves'), ['Stampor Hoof']);
    assert.deepEqual(titles('kitchen knives'), ['Kitchen Knife']);
    assert.deepEqual(titles('blue berries'), ['Blueberry (Item)']);
    assert.deepEqual(titles('wooden boxes'), ['Wooden Box']);
    assert.deepEqual(titles('frosty ears of a troll'), ['Frosty Ear of a Troll']);
    // An inactive item resolves by its exact title only.
    assert.deepEqual(titles('stones'), []);
    assert.deepEqual(resolveItemName(db, 'stone').map((r) => r.title), []);
    assert.deepEqual(resolveItemName(db, 'stone (event)').map((r) => r.title), ['Stone (Event)']);
  } finally {
    db.close();
  }
});

test('a nonsense name or plural stays unresolved', () => {
  resolving(FIXTURE, (titles) => {
    assert.deepEqual(titles('blorbs', { count: 3 }), []);
    assert.deepEqual(titles('blorbs'), []);
    assert.deepEqual(titles('dragon shieldses', { count: 2 }), []);
  });
});

// Review Focus 1: the counted word is also another item's title or plural.
test('a counted plural that is also another item\'s name resolves to the stackable item', () => {
  resolving(DB_PATH, (titles, db) => {
    const row = (title: string) =>
      db.prepare('select plural, is_stackable from item where title = ?').get(title);
    assert.equal(row('Gold Nuggets')?.is_stackable, 0, 'guard: Gold Nuggets does not stack');
    assert.equal(row('Red Rose')?.plural, null, 'guard: Red Rose records no plural');
    assert.ok(row('Red Roses'), 'guard: Red Roses is a title');
    assert.deepEqual(titles('gold nuggets', { count: 3 }), ['Gold Nugget']);
    assert.deepEqual(titles('bones', { count: 2 }), ['Bone']);
    assert.deepEqual(titles('red roses', { count: 2 }), ['Red Rose']);
    // Without a count, the exact title wins.
    assert.deepEqual(titles('gold nuggets'), ['Gold Nuggets']);
    assert.deepEqual(titles('red roses'), ['Red Roses']);
  });
});

test('an exact title wins over the same name another item prints', () => {
  resolving(DB_PATH, (titles, db) => {
    const shared = db.prepare(
      `select title from item where actual_name = 'cheese' and status = 'active' order by title`).all();
    assert.ok(shared.length > 1, 'guard: more than one item prints "cheese"');
    assert.deepEqual(titles('cheese'), ['Cheese']);
  });
});

// Review Focus 2: a name two items print, settled by the creature that drops it.
test('a name two items print is ambiguous until a creature settles it', () => {
  resolving(FIXTURE, (titles) => {
    assert.deepEqual(titles('book'), ['Book (Brown)', 'Book (Gemmed)']);
    assert.deepEqual(titles('books', { count: 2 }), ['Book (Brown)', 'Book (Gemmed)']);
  });
  resolving(DB_PATH, (titles, db) => {
    // A name exactly two active items print, no title, and a creature that drops only one.
    const found = db.prepare(
      `select a.actual_name as name, a.title as dropped, b.title as other, c.article_id as creature
         from item a
         join item b on b.actual_name = a.actual_name collate nocase
                    and b.article_id <> a.article_id and b.status = 'active'
         join creature_drop d on d.item_id = a.article_id
         join creature c on c.article_id = d.creature_id
        where a.status = 'active'
          and not exists (select 1 from item t where t.title = a.actual_name)
          and (select count(*) from item x where x.status = 'active'
                and x.actual_name = a.actual_name collate nocase) = 2
          and not exists (select 1 from creature_drop e
                           where e.creature_id = c.article_id and e.item_id = b.article_id)
        order by a.actual_name, a.title, c.title limit 1`).get();
    assert.ok(found, 'guard: the index holds a name two items print and one creature drops');
    const name = String(found.name);
    // The resolver's order: by folded title, then exactly.
    const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    const both = [String(found.dropped), String(found.other)]
      .sort((a, b) => byCode(asciiLower(a), asciiLower(b)) || byCode(a, b));
    assert.deepEqual(titles(name), both);
    assert.deepEqual(titles(name, { dropsOf: new Set([Number(found.creature)]) }), [String(found.dropped)]);

    const cutthroat = creatureIds(db, 'Pirate Cutthroat');
    assert.deepEqual(titles('treasure map'), ['Treasure Map']);
    assert.deepEqual(titles('treasure map', { count: 1, dropsOf: cutthroat }), ['Treasure Map (Pirate)']);
  });
});

test('a creature keeps the matches it drops, and one that drops none keeps them all', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`create table item (article_id integer primary key, title text collate nocase,
               actual_name text, plural text, status text, is_stackable integer);
             create table creature_drop (creature_id integer, item_id integer);
             insert into item values
               (1, 'Map', 'map', null, 'active', 0),
               (2, 'Map (Pirate)', 'map', null, 'active', 0),
               (3, 'Map (Store)', 'map', null, 'active', 0);
             insert into creature_drop values (10, 2), (11, 3), (12, 1);`);
    const titles = (name: string, count: number | undefined, drops: number[]) =>
      resolveItemName(db, name, { count, dropsOf: new Set(drops) }).map((r) => r.title);
    assert.deepEqual(titles('map', 1, [10]), ['Map (Pirate)']);
    assert.deepEqual(titles('map', undefined, [10, 11]), ['Map (Pirate)', 'Map (Store)']);
    assert.deepEqual(titles('map', 1, [99]), ['Map']);
    assert.deepEqual(titles('maps', 2, [10]), ['Map (Pirate)']);
    assert.deepEqual(titles('maps', 2, [99]), ['Map', 'Map (Pirate)', 'Map (Store)']);
  } finally {
    db.close();
  }
});
