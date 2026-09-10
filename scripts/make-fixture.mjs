// Builds the committed test fixture from a full generated database.
// Retention is a bounded contract, not "everything reachable" - see the plan's Task 2.
//   node scripts/make-fixture.mjs data/tibiawiki.db test/fixtures/tibiawiki-fixture.db
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, rmSync } from 'node:fs';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) throw new Error('usage: make-fixture.mjs <full.db> <fixture.db>');

rmSync(dest, { force: true });
copyFileSync(src, dest);
const db = new DatabaseSync(dest);

/** @type {(sql: string, ...p: Array<string|number>) => number[]} */
const ids = (sql, ...p) =>
  db.prepare(sql).all(...p).map((r) => Number(Object.values(r)[0]));
/** @type {(xs: number[]) => string} */
const list = (xs) => (xs.length ? xs.join(',') : '-1');

// Named creatures: fire-immune (Dragon 0), neutral (Rotworm 100) and fire-weak
// (Tarantula 115, Scarab 118) so weakness tests have both sides, plus one
// non-active row so the status filter has something to exclude.
const NAMED_CREATURES = ['Dragon', 'Dragon Lord', 'Rotworm', 'Demon', 'Cyclops', 'Tarantula', 'Scarab'];
// Magic Longsword: the zero-source case. Steel Helmet: the vendor case, and its
// droppers carry the only null-chance rows. Gold Coin: the currency join target.
// Mud: the corpus's only cross-type title collision, for the ambiguous-name branch.
const NAMED_ITEMS = ['Magic Longsword', 'Steel Helmet', 'Gold Coin', 'Mud'];

let keepCreature = ids(
  `select article_id from creature where title in (${NAMED_CREATURES.map(() => '?').join(',')})`,
  ...NAMED_CREATURES,
);
const inactive = ids("select article_id from creature where status <> 'active' limit 1");
keepCreature = [...new Set([...keepCreature, ...inactive])];

let keepItem = ids(
  `select article_id from item where title in (${NAMED_ITEMS.map(() => '?').join(',')})`,
  ...NAMED_ITEMS,
);
keepItem = [...new Set([
  ...keepItem,
  ...ids(`select distinct item_id from creature_drop where creature_id in (${list(keepCreature)})`),
])];

// Pull in the creatures that drop Steel Helmet specifically - 22 of them, 3 with a
// null chance, without which the nulls-last ordering that get/how-to-obtain rely on
// cannot be tested. Deliberately NOT every retained item: Gold Coin alone is dropped
// by ~1200 creatures, which would balloon the fixture past its 1 MB budget.
const DROPPER_EXPANSION = ['Steel Helmet'];
keepCreature = [...new Set([
  ...keepCreature,
  ...ids(
    `select distinct d.creature_id from creature_drop d join item i on i.article_id = d.item_id
     where i.title in (${DROPPER_EXPANSION.map(() => '?').join(',')})`,
    ...DROPPER_EXPANSION,
  ),
])];

// Foreign keys are enforced, and more tables reference these than the ones named
// above (creature_ability, item_key, npc_job, ...). Rather than hand-order every
// delete, drop the primary rows with FKs off, then let foreign_key_check find and
// remove every orphan it created. The check loop is the correctness proof.
db.exec('pragma foreign_keys = off');
db.exec(`delete from creature where article_id not in (${list(keepCreature)})`);
db.exec(`delete from item where article_id not in (${list(keepItem)})`);
// Referential integrity: a drop must point at a surviving creature AND item.
db.exec(`delete from creature_drop where creature_id not in (${list(keepCreature)})
         or item_id not in (${list(keepItem)})`);
for (const t of ['npc_offer_buy', 'npc_offer_sell']) {
  db.exec(`delete from ${t} where item_id not in (${list(keepItem)})`);
}
const keepNpc = [...new Set([
  ...ids('select distinct npc_id from npc_offer_buy'),
  ...ids('select distinct npc_id from npc_offer_sell'),
  ...ids("select article_id from npc where title = 'Mud'"),
])];
db.exec(`delete from npc where article_id not in (${list(keepNpc)})`);
db.exec(`delete from quest_reward where item_id not in (${list(keepItem)})`);
db.exec('delete from quest where article_id not in (select quest_id from quest_reward)');
db.exec(`delete from item_attribute where item_id not in (${list(keepItem)})`);

// Empty every table no tool in this plan queries. The tables themselves are kept so
// the schema stays identical to a real index; only their rows go. Without this the
// fixture is ~3.3 MB of house/achievement/game_update rows nothing ever reads.
const USED = new Set([
  'creature', 'item', 'item_attribute', 'creature_drop', 'npc',
  'npc_offer_sell', 'npc_offer_buy', 'quest', 'quest_reward', 'spell', 'database_info',
]);
const allTables = db
  .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
  .all()
  .map((r) => String(r.name));
for (const t of allTables) {
  if (!USED.has(t)) db.exec(`delete from "${t}"`);
}

// Sweep orphans until the database is referentially clean.
for (let pass = 1; ; pass++) {
  const bad = db.prepare('pragma foreign_key_check').all();
  if (bad.length === 0) { console.log(`  referential integrity clean after ${pass - 1} sweep(s)`); break; }
  if (pass > 10) throw new Error(`foreign_key_check still failing after 10 sweeps: ${bad.length} rows`);
  const byTable = new Map();
  for (const r of bad) {
    if (!byTable.has(r.table)) byTable.set(r.table, []);
    byTable.get(r.table).push(r.rowid);
  }
  for (const [table, rowids] of byTable) {
    db.exec(`delete from "${table}" where rowid in (${rowids.join(',')})`);
  }
}
db.exec('pragma foreign_keys = on');
db.exec('vacuum');

/** @type {(t: string) => number} */
const count = (t) => Number(db.prepare(`select count(*) c from ${t}`).get()?.c ?? 0);
const summary = Object.fromEntries(
  ['creature', 'item', 'creature_drop', 'npc', 'npc_offer_sell', 'npc_offer_buy',
   'quest', 'quest_reward', 'item_attribute', 'spell', 'database_info'].map((t) => [t, count(t)]),
);
const nulls = Number(
  db.prepare('select count(*) c from creature_drop where chance is null').get()?.c ?? 0,
);
db.close();
console.log('fixture written:', dest);
console.log('  rows:', JSON.stringify(summary));
console.log('  null-chance drops:', nulls);
