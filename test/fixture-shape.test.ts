import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { MCP_SCHEMA_VERSION } from '../src/db.ts';
import { MCP_SCHEMA_VERSION as INDEXER_VERSION } from '../src/indexer/enrich.ts';
import { FIXTURE } from './harness.ts';

/**
 * The fixture is committed, so its size is a real cost on every clone. An ungated
 * budget is a budget nobody checks.
 */
const MAX_FIXTURE_BYTES = 1_500_000;

test('every fixture image row has a surviving parent', () => {
  // mcp_image rides on neither keepByType nor the FK sweep, so it is pruned
  // explicitly after the sweep. An orphan here means that pruning regressed.
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  const orphans: string[] = [];
  for (const type of ['creature', 'item', 'npc', 'spell', 'mount', 'imbuement', 'charm']) {
    const { c } = db.prepare(
      `select count(*) c from mcp_image m
         where m.entity_type = ?
           and m.article_id not in (select article_id from "${type}")`,
    ).get(type) as { c: number };
    if (c > 0) orphans.push(`${type}: ${c}`);
  }
  db.close();
  assert.deepEqual(orphans, [], 'image rows whose parent was pruned away');
});

test('the committed fixture stays within its size budget', () => {
  const bytes = statSync(FIXTURE).size;
  assert.ok(
    bytes <= MAX_FIXTURE_BYTES,
    `fixture is ${(bytes / 1e6).toFixed(2)} MB, over the ${MAX_FIXTURE_BYTES / 1e6} MB budget`,
  );
});

test('the runtime and the indexer agree on the enrichment schema version', () => {
  // db.ts declares this rather than importing it, to keep the build-time network
  // module out of the server. A drift between the two would make the probe reject
  // every freshly built index.
  assert.equal(MCP_SCHEMA_VERSION, INDEXER_VERSION);
});

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
  'npc_job', 'npc_race', 'npc_destination', 'npc_location', 'quest_danger',
  'mcp_area_pattern', 'mcp_ability_area', 'mcp_schema_version', 'mcp_image', 'mcp_spell_area',
  'item_client_id', 'creature_location_coordinate', 'item_location_coordinate',
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

/**
 * Table-wide counts are NOT sufficient, and this project has the scar to prove it:
 * `quest_danger` held 90 rows from incidental quests while the deliberately named
 * quest had 0 of its 60, because retaining a quest without its danger creatures let
 * the orphan sweep delete them. A guard must assert the NAMED anchor has its child
 * rows, not that the table is non-empty somewhere.
 */
const ANCHOR_CHILDREN: ReadonlyArray<readonly [string, string, string]> = [
  // [description, parent title, SQL counting that parent's child rows]
  ['Dragon abilities', 'Dragon',
   `select count(*) c from creature_ability a join creature c on c.article_id = a.creature_id where c.title = ?`],
  // Per-type, because REQUIRED_NON_EMPTY stays green on 209 spell image rows alone
  // while every creature or charm image is pruned away - the quest_danger scar.
  ['Dragon image', 'Dragon',
   `select count(*) c from mcp_image m join creature e on e.article_id = m.article_id
      where m.entity_type = 'creature' and e.title = ?`],
  ['Adrenaline Burst image', 'Adrenaline Burst',
   `select count(*) c from mcp_image m join charm e on e.article_id = m.article_id
      where m.entity_type = 'charm' and e.title = ?`],
  ['Powerful Reap image', 'Powerful Reap',
   `select count(*) c from mcp_image m join imbuement e on e.article_id = m.article_id
      where m.entity_type = 'imbuement' and e.title = ?`],
  // Per-spell, because REQUIRED_NON_EMPTY stays green on any surviving shape row
  // while Avalanche's is pruned away - the quest_danger scar.
  ['Avalanche area shape', 'Avalanche',
   `select count(*) c from mcp_spell_area m join spell s on s.article_id = m.article_id
      where s.title = ?`],
  ['Dragon max damage', 'Dragon',
   `select count(*) c from creature_max_damage m join creature c on c.article_id = m.creature_id where c.title = ?`],
  ['Golden Key keys', 'Golden Key',
   `select count(*) c from item_key k join item i on i.article_id = k.item_id where i.title = ?`],
  ['Crypt Bile perks', 'Crypt Bile',
   `select count(*) c from item_proficiency_perk p join item i on i.article_id = p.item_id where i.title = ?`],
  ['Strong Mana Potion store offers', 'Strong Mana Potion',
   `select count(*) c from item_store_offer o join item i on i.article_id = o.item_id where i.title = ?`],
  ['Captain Bluebear destinations', 'Captain Bluebear',
   `select count(*) c from npc_destination d join npc n on n.article_id = d.npc_id where n.title = ?`],
  ['Forgotten Knowledge Quest dangers', 'Forgotten Knowledge Quest',
   `select count(*) c from quest_danger d join quest q on q.article_id = d.quest_id where q.title = ?`],
  ['Powerful Reap materials', 'Powerful Reap',
   `select count(*) c from imbuement_material m join imbuement b on b.article_id = m.imbuement_id where b.title = ?`],
  ['Assassin Outfits quests', 'Assassin Outfits',
   `select count(*) c from outfit_quest q join outfit o on o.article_id = q.outfit_id where o.title = ?`],
  ['War Golem coordinates', 'War Golem',
   `select count(*) c from creature_location_coordinate l join creature c on c.article_id = l.creature_id
      where c.title = ?`],
  ['Lump of Dough coordinates', 'Lump of Dough',
   `select count(*) c from item_location_coordinate l join item i on i.article_id = l.item_id where i.title = ?`],
  ['Shallow Water client IDs', 'Shallow Water',
   `select count(*) c from item_client_id k join item i on i.article_id = k.item_id where i.title = ?`],
];

test('each named anchor actually carries its own child rows', () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  const missing: string[] = [];
  for (const [label, title, sql] of ANCHOR_CHILDREN) {
    const { c } = db.prepare(sql).get(title) as { c: number };
    if (c === 0) missing.push(label);
  }
  db.close();
  assert.deepEqual(missing, [],
    'these anchors have zero child rows, so a detail test naming them proves nothing');
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

  // A buy price in gold says nothing about one in Theons or Gold Tokens, so the value
  // sort and valueBuyCurrency need items priced in other currencies to prove anything.
  assert.deepEqual(
    db.prepare(`select title, value_buy, value_buy_currency from item
                where title in ('25 Years Backpack', 'Blade of Mayhem') order by title`).all()
      .map((r) => [r.title, r.value_buy, r.value_buy_currency]),
    [['25 Years Backpack', 7197, 'Theons'], ['Blade of Mayhem', 50, 'Gold Token']],
  );

  assert.equal(count('select count(*) c from rashid_position'), 7);
  assert.equal(count(
    `select count(*) c from creature_ability a join creature c on c.article_id = a.creature_id
     where c.title = ?`, 'Dragon'), 4);
  db.close();
});

/**
 * Anchors for data 3.5.0 (generator 9.0.0+tibiash.10), where an unknown value became
 * NULL and an explicit one stayed as written. Each names the row a later tool test reads.
 */
type CreatureRow = Record<string, number | string | null>;
const creatureRow = (db: DatabaseSync, title: string, columns: string): CreatureRow | undefined =>
  db.prepare(`select ${columns} from creature where title = ?`).get(title) as CreatureRow | undefined;

test('Dragon keeps its explicit values: paraimmune, fire-immune, not summonable', () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  const dragon = creatureRow(db, 'Dragon', 'paralysable, modifier_fire, summon_cost');
  db.close();
  // paralysable 0 is an explicit "cannot be paralysed", not an unknown read as false.
  assert.deepEqual({ ...dragon }, { paralysable: 0, modifier_fire: 0, summon_cost: 0 });
});

test('Mimic carries its unknown armor as NULL', () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  const mimic = creatureRow(db, 'Mimic', 'armor');
  db.close();
  assert.ok(mimic, 'guard: Mimic is in the fixture');
  assert.equal(mimic.armor, null);
});

test('War Golem carries the haste, debuff and outfit ability kinds', () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  const kinds = db.prepare(
    `select distinct a.element from creature_ability a join creature c on c.article_id = a.creature_id
      where c.title = 'War Golem' and a.element in ('haste', 'debuff', 'outfit') order by a.element`,
  ).all().map((r) => r.element);
  db.close();
  assert.deepEqual(kinds, ['debuff', 'haste', 'outfit']);
});

test('Shallow Water carries every client ID in order', () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  const rows = db.prepare(
    `select k.client_id, k.position from item_client_id k join item i on i.article_id = k.item_id
      where i.title = 'Shallow Water' order by k.position`,
  ).all().map((r) => [r.client_id, r.position]);
  db.close();
  // More than one ID, so a lookup by a later client ID has something to find.
  assert.deepEqual(rows, [[629, 0], [630, 1], [631, 2], [632, 3], [633, 4], [634, 5]]);
});

test('Lump of Dough has a trade value note and a location', () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  const item = db.prepare(
    `select trade_value_note, location from item where title = 'Lump of Dough'`,
  ).get() as { trade_value_note: string | null; location: string | null } | undefined;
  db.close();
  assert.ok(item, 'guard: Lump of Dough is in the fixture');
  assert.equal(item.trade_value_note, 'Negotiable');
  assert.notEqual(item.location, null);
});
