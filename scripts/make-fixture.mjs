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
// The Rootkraken has hitpoints 0 alongside 700,000 experience: the wiki does not
// record its health, and 0 must not read as a real value. Without it in the fixture
// the unrecorded-hitpoints tests pass vacuously.
const NAMED_CREATURES = [
  'Dragon', 'Dragon Lord', 'Rotworm', 'Demon', 'Cyclops', 'Tarantula', 'Scarab',
  'The Rootkraken',
  // Three rows all named 'Poison Ball': (creature_id, name) is not unique, so this
  // is the anchor proving detail joins keep all three rather than collapsing them.
  'The Plasmother',
];
// Magic Longsword: the zero-source case. Steel Helmet: the vendor case, and its
// droppers carry the only null-chance rows. Gold Coin: the currency join target.
// Mud: the corpus's only cross-type title collision, for the ambiguous-name branch.
// Moonsilver Axe carries defense "33 +3": the five "numeric" attributes are not
// always integers, and Number() on that yields NaN, which the tools' outputSchema
// rejects. Arrow (Weak) is status 'ts-only', so how_to_obtain has a non-active
// subject with active vendors to warn about. Both are regression anchors.
const NAMED_ITEMS = [
  'Magic Longsword', 'Steel Helmet', 'Gold Coin', 'Mud',
  'Moonsilver Axe', 'Arrow (Weak)',
  // Detail-section anchors. item_key is one-to-many (Silver Key has 61 rows), so
  // Golden Key's 7 prove keys[] is a collection without bloating the fixture.
  'Golden Key', 'Crypt Bile', 'Strong Mana Potion',
];

// One named row per new entity type, each chosen because it actually HAS the child
// rows the detail tests assert on - a type with no children proves nothing.
const NAMED_BY_TYPE = {
  achievement: ['Allow Cookies?', 'Backpack Tourist'],
  house: ["Warriors' Guildhall", 'The Tibianic'],   // rent 5,000,000 / 500,000
  imbuement: ['Powerful Reap', 'Powerful Venom'],   // 3 materials each
  charm: ['Adrenaline Burst', 'Bless'],
  mount: ['Donkey', 'Racing Bird'],
  outfit: ['Assassin Outfits', 'Beggar Outfits'],   // 2 outfit_quest rows each
  book: ['Goldfinger (Book)'],                      // has item_id and the shortest text
  world: ['Antica', 'Astera'],
  game_update: ['Updates/7.9', 'Updates/8.00'],
};
// Captain Bluebear carries 12 npc_destination rows; the committed fixture had ZERO,
// so "an NPC with destinations" could not have passed. Rashid anchors the 7-row
// weekly schedule that rashid_position feeds.
const NAMED_NPCS = ['Captain Bluebear', 'Rashid'];
// 60 quest_danger rows, and the quest tables were otherwise derived only via rewards.
const NAMED_QUESTS = ['Forgotten Knowledge Quest'];

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

// Retain the named rows for every new entity type, then pull in each one's FK
// targets. This ordering matters: the orphan sweep below DELETES an offending row
// rather than repairing it, so a named row whose target is missing would be removed.
/** @type {Map<string, number[]>} */
const keepByType = new Map();
for (const [table, names] of Object.entries(NAMED_BY_TYPE)) {
  const found = ids(
    `select article_id from "${table}" where title in (${names.map(() => '?').join(',')})`,
    ...names,
  );
  // A misspelled name silently yields an empty retention set and an empty table,
  // which is exactly how a test comes to pass vacuously. Fail loudly instead.
  if (found.length !== names.length) {
    throw new Error(
      `${table}: retained ${found.length} of ${names.length} named rows — check NAMED_BY_TYPE spelling`,
    );
  }
  keepByType.set(table, found);
}
/** @type {(t: string) => number[]} */
const kept = (t) => keepByType.get(t) ?? [];
// book.item_id -> item, imbuement_material.item_id -> item, outfit_quest.quest_id -> quest
keepItem = [...new Set([
  ...keepItem,
  ...ids(`select item_id from book where article_id in (${list(kept('book'))}) and item_id is not null`),
  ...ids(`select item_id from imbuement_material where imbuement_id in (${list(kept('imbuement'))})`),
])];
const namedNpcIds = ids(
  `select article_id from npc where title in (${NAMED_NPCS.map(() => '?').join(',')})`, ...NAMED_NPCS);
const namedQuestIds = [...new Set([
  ...ids(`select article_id from quest where title in (${NAMED_QUESTS.map(() => '?').join(',')})`, ...NAMED_QUESTS),
  ...ids(`select quest_id from outfit_quest where outfit_id in (${list(kept('outfit'))})`),
])];
// quest_danger points at creatures. Retaining a quest without its danger creatures
// means the sweep deletes every one of its danger rows - Forgotten Knowledge Quest
// lost all 60 that way, while the table still held 90 rows from other quests, so a
// table-wide emptiness check saw nothing wrong.
keepCreature = [...new Set([
  ...keepCreature,
  ...ids(`select distinct creature_id from quest_danger where quest_id in (${list(namedQuestIds)})`),
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
  ...namedNpcIds,
])];
db.exec(`delete from npc where article_id not in (${list(keepNpc)})`);
db.exec(`delete from quest_reward where item_id not in (${list(keepItem)})`);
db.exec(`delete from quest where article_id not in (select quest_id from quest_reward)
         and article_id not in (${list(namedQuestIds)})`);
db.exec(`delete from item_attribute where item_id not in (${list(keepItem)})`);

// Empty every table no tool in this plan queries. The tables themselves are kept so
// the schema stays identical to a real index; only their rows go. Without this the
// fixture is ~3.3 MB of house/achievement/game_update rows nothing ever reads.
const USED = new Set([
  'creature', 'item', 'item_attribute', 'creature_drop', 'npc',
  'npc_offer_sell', 'npc_offer_buy', 'quest', 'quest_reward', 'spell', 'database_info',
  // Child tables the detail sections read. They are pruned by the orphan sweep, which
  // is what keeps them small - their parents are already limited to named rows.
  'creature_ability', 'creature_max_damage', 'creature_sound',
  'item_key', 'item_sound', 'item_store_offer', 'item_proficiency_perk',
  'npc_job', 'npc_race', 'npc_destination', 'quest_danger',
  'imbuement_material', 'outfit_quest',
]);
// rashid_position has no article_id (day, city, location, x, y, z) and is only 7 rows.
// The area tables are written by the enrichment pass, not the generator:
// mcp_area_pattern is 114 small rows and is the lookup target for every retained
// ability, so trimming it would only create dangling keys; mcp_schema_version is a
// single row the probe requires, and emptying it makes the fixture unopenable.
const KEEP_WHOLE = new Set(['rashid_position', 'mcp_area_pattern', 'mcp_schema_version']);
// mcp_image is keyed (entity_type, article_id) across seven parent tables, so it
// rides on neither keepByType (which prunes by article_id inside one table) nor the
// FK sweep (it declares no FK). Pruned from the rows that actually SURVIVE, after
// the sweep below, rather than from re-derived id sets.
const IMAGE_PARENTS = ['creature', 'item', 'npc', 'spell', 'mount', 'imbuement', 'charm'];
const allTables = db
  .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
  .all()
  .map((r) => String(r.name));
for (const t of allTables) {
  if (USED.has(t)) continue;
  if (keepByType.has(t)) {
    db.exec(`delete from "${t}" where article_id not in (${list(kept(t))})`);
  } else if (t === 'mcp_image') {
    // Deferred: pruned after the orphan sweep, once parents have stopped changing.
  } else if (t === 'mcp_ability_area') {
    // Keyed by creature_id, so it cannot ride on keepByType (which prunes by
    // article_id) nor on the foreign-key sweep (whose FK points at the pattern
    // table, not at creature).
    db.exec(`delete from "${t}" where creature_id not in (${list(keepCreature)})`);
  } else if (KEEP_WHOLE.has(t)) {
    // small and keyed by something other than article_id
  } else {
    db.exec(`delete from "${t}"`);
  }
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
// Now that parents have stopped changing, keep only the image rows whose parent
// actually survived. Doing this before the sweep would retain rows for parents the
// sweep then deletes.
for (const table of IMAGE_PARENTS) {
  db.exec(
    `delete from mcp_image where entity_type = '${table}'
       and article_id not in (select article_id from "${table}")`,
  );
}
const orphanImages = Number(
  db.prepare(`select count(*) c from mcp_image m where not exists (
       select 1 from creature c where c.article_id = m.article_id and m.entity_type = 'creature')
     and m.entity_type = 'creature'`).get()?.c ?? 0,
);
if (orphanImages > 0) throw new Error(`mcp_image still holds ${orphanImages} orphaned creature rows`);

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
