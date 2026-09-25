import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/**
 * Business policy lives here and nowhere else. Every string this module returns is
 * interpolated directly into SQL, so each map is whitelist-only and throws on an
 * unknown key. No caller ever interpolates raw input.
 */

export const ELEMENTS = [
  'physical', 'earth', 'fire', 'ice', 'energy',
  'death', 'holy', 'drown', 'lifedrain', 'healing',
] as const;
export type Element = (typeof ELEMENTS)[number];
export const elementSchema = z.enum(ELEMENTS);

export function modifierColumn(element: Element): string {
  if (!ELEMENTS.includes(element)) throw new Error(`Unknown element: ${String(element)}`);
  return `modifier_${element}`;
}

/**
 * Damage modifiers are percentages where 100 is neutral. Above 100 the creature
 * takes extra damage from that element; below 100 it resists. Encoding the
 * convention here keeps it out of every tool and out of the model's head.
 */
export const WEAK_TO = (column: string): string => `${column} > 100`;
export const RESISTANT_TO = (column: string): string => `${column} < 100`;

/**
 * What an item can resist: every element but healing, which no item resists, plus mana
 * drain and critical hits, which are no creature element. An item's resistance is a
 * percentage in `item_attribute`, where above 0 protects and below 0 is a weakness.
 * Four go by other names there.
 */
export const ITEM_RESISTANCES = [
  'physical', 'earth', 'fire', 'ice', 'energy', 'death', 'holy', 'drown', 'lifedrain',
  'manadrain', 'critical_hit',
] as const;
export type ItemResistance = (typeof ITEM_RESISTANCES)[number];
const RESISTANCE_ATTRS: Record<ItemResistance, string> = {
  physical: 'resistance_physical',
  earth: 'resistance_earth',
  fire: 'resistance_fire',
  ice: 'resistance_ice',
  energy: 'resistance_energy',
  death: 'resistance_death',
  holy: 'resistance_holy',
  drown: 'resistance_drowning',
  lifedrain: 'resistance_life_drain',
  manadrain: 'resistance_mana_drain',
  critical_hit: 'resistance_critical_hit_chance',
};
export function resistanceAttribute(element: ItemResistance): string {
  if (!Object.hasOwn(RESISTANCE_ATTRS, element)) {
    throw new Error(`Unknown element: ${String(element)}`);
  }
  return RESISTANCE_ATTRS[element];
}

/** The skill bonus attributes of an item, each a signed number such as "+2". */
export const ITEM_SKILLS = [
  'magic_level', 'sword', 'axe', 'club', 'distance', 'fist', 'shielding',
] as const;

/**
 * The values of the `hands` attribute, lowercased like every other input. The attribute
 * holds them capitalised, so they match with collate nocase.
 */
export const ITEM_HANDS = ['one', 'two'] as const;

export const ENTITY_TYPES = [
  'creature', 'item', 'npc', 'quest', 'spell',
  'achievement', 'house', 'imbuement', 'charm', 'mount', 'outfit', 'book',
  'world', 'update',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const entityTypeSchema = z.enum(ENTITY_TYPES);

/**
 * Per-type facts. `table` is interpolated into SQL, so lookups go through
 * Object.hasOwn rather than a truthiness check: a plain-object lookup resolves
 * inherited names, and `ENTITIES['toString']` would otherwise return a function.
 *
 *
 * `hasStatus` is false for `world` and `update`: those two tables have no `status`
 * column, and filtering them raises `no such column: t.status`.
 */
const ENTITIES: Record<EntityType, { table: string; hasStatus: boolean }> = {
  creature: { table: 'creature', hasStatus: true },
  item: { table: 'item', hasStatus: true },
  npc: { table: 'npc', hasStatus: true },
  quest: { table: 'quest', hasStatus: true },
  spell: { table: 'spell', hasStatus: true },
  achievement: { table: 'achievement', hasStatus: true },
  house: { table: 'house', hasStatus: true },
  imbuement: { table: 'imbuement', hasStatus: true },
  charm: { table: 'charm', hasStatus: true },
  mount: { table: 'mount', hasStatus: true },
  outfit: { table: 'outfit', hasStatus: true },
  book: { table: 'book', hasStatus: true },
  world: { table: 'world', hasStatus: false },
  update: { table: 'game_update', hasStatus: false },
};

function entity(type: EntityType): { table: string; hasStatus: boolean } {
  if (!Object.hasOwn(ENTITIES, type)) {
    throw new Error(`Unknown entity type: ${String(type)}`);
  }
  return ENTITIES[type];
}

export function entityTable(type: EntityType): string {
  return entity(type).table;
}
export function entityHasStatus(type: EntityType): boolean {
  return entity(type).hasStatus;
}

/**
 * The order by expr in direction, rows without a value last and title breaking ties, so
 * every sort is total and a cursor's offset stays stable across pages.
 */
const nullsLast = (expr: string, direction: 'asc' | 'desc'): string =>
  `(${expr} is null), ${expr} ${direction}, title asc`;

/**
 * The values of `creature.bestiary_level`, lowercased like every other input. The
 * column holds them capitalised, so they match with collate nocase.
 */
export const CREATURE_BESTIARY_LEVELS = [
  'harmless', 'trivial', 'easy', 'medium', 'hard', 'challenging',
] as const;

/**
 * What a model needs to read a result correctly, written once. Each text is the description
 * of its output fields and a sentence of the server instructions: a host gives the model the
 * instructions and the input schemas, not the output schemas, so the instructions are where
 * the model learns it, and sharing the text keeps the two from drifting.
 */
export const RUNS_AT_MEANING = 'Hit points at which it flees. 0: never flees.';
export const SUMMON_COST_MEANING = 'Mana. 0: cannot be summoned.';
export const CONVINCE_COST_MEANING = 'Mana. 0: cannot be convinced.';
export const GOLD_PER_KILL_MEANING =
  'Estimated gross loot value at NPC prices. Drops without a recorded chance are left out, ' +
  'and items that sell only on the market count as 0.';
export const IMAGE_MEANING = 'Sprite image link. Dimensions are pixels, not map squares.';
export const RASHID_PLACE_MEANING =
  "For Rashid, who moves city daily, a buyer's city and position coordinates are null. His NPC page and " +
  'tibia_where_to_sell give his week as rashidSchedule.';

/**
 * Creature numbers the wiki gives a meaning at 0, described once for every tool that
 * reports them. The value is reported as the wiki records it.
 */
export const runsAtSchema = z.number().nullable().describe(RUNS_AT_MEANING);
export const summonCostSchema = z.number().nullable().describe(SUMMON_COST_MEANING);
export const convinceCostSchema = z.number().nullable().describe(CONVINCE_COST_MEANING);

/**
 * Names as the game prints them in look, loot and kill messages, which can differ from the
 * wiki title: Lifefluid prints as "vial of lifefluid". Null where the wiki records none.
 */
export const inGameNameSchema = z.string().nullable().describe('Name as the game prints it.');
export const inGamePluralSchema = z.string().nullable().describe('Plural as the game prints it.');
export const inGameArticleSchema = z.string().nullable()
  .describe('Article the game prints before the name. Null: none, as for bosses.');

/**
 * The best gold price an NPC pays for each item, as a subquery with one row per item:
 * `item_id`, `npc_id` (the buyer) and `price`. The price is the highest `npc_offer_buy.value`
 * in Gold Coin from an active NPC, and a tie goes to the NPC whose title comes first.
 * npc_offer_buy holds exact duplicate rows, and ranking keeps one row per item, so they
 * cannot change a result. An item no active NPC buys for gold has no row.
 */
export const BEST_GOLD_PRICE =
  `select item_id, npc_id, price from (
     select o.item_id, o.npc_id, o.value as price,
            row_number() over (partition by o.item_id order by o.value desc, n.title asc) as rank
       from npc_offer_buy o
       join npc n on n.article_id = o.npc_id
       join item cur on cur.article_id = o.currency_id
      where ${statusClause('n', false)} and cur.title = 'Gold Coin'
   ) where rank = 1`;

/**
 * What each coin is worth in gold, by item title. The titles hold no quote, so GOLD_PER_KILL
 * writes them into its SQL as literals.
 */
const COIN_FACE_VALUES: Readonly<Record<string, number>> = {
  'Gold Coin': 1, 'Platinum Coin': 100, 'Crystal Coin': 10000,
};

/**
 * A coin's value in gold, or null for an item that is no coin. Unlike this module's maps, it
 * answers an unknown title rather than throwing, since any item title may be asked.
 */
export const coinFaceValue = (title: string): number | null =>
  Object.hasOwn(COIN_FACE_VALUES, title) ? COIN_FACE_VALUES[title]! : null;

/**
 * Estimated gold per kill, as a subquery with one row per creature that has a drop with a
 * recorded chance: `creature_id` and `gold_per_kill`. Each such drop is worth
 * chance / 100 x average amount x unit value, summed and rounded to an integer. The amount
 * is `max` when `min` is 0, since tibiawiki-sql stores an amount written without a range
 * as `min` 0, and the midpoint of the range otherwise. Coins count at COIN_FACE_VALUES, any
 * other item at its BEST_GOLD_PRICE, and an item with neither counts 0.
 */
export const GOLD_PER_KILL =
  `select d.creature_id, cast(round(sum(d.chance / 100.0
            * (case when d.min = 0 then d.max else (d.min + d.max) / 2.0 end)
            * coalesce(case i.title ${Object.entries(COIN_FACE_VALUES)
                .map(([title, value]) => `when '${title}' then ${value}`).join(' ')} end,
                       best.price, 0)
          )) as integer) as gold_per_kill
     from creature_drop d
     join item i on i.article_id = d.item_id
     left join (${BEST_GOLD_PRICE}) best on best.item_id = d.item_id
    where d.chance is not null
    group by d.creature_id`;

export const goldPerKillSchema = z.number().nullable().describe(GOLD_PER_KILL_MEANING);

/** Map coordinates, each null where the wiki records none. */
export const positionSchema = z.object({
  x: z.number().nullable(), y: z.number().nullable(), z: z.number().nullable(),
});
type Position = z.infer<typeof positionSchema>;

/**
 * Rashid moves to another city every day, so the city and position the wiki records for
 * him (Svargrond) are right one day a week. His week is in `rashid_position`.
 */
export const RASHID = 'Rashid';

/** Rashid's week, Monday first, for `db.prepare` with no parameters. */
export const RASHID_SCHEDULE =
  'select day, city, location, x, y, z from rashid_position order by day asc';

// tibiawiki-sql: "Day of the week, Monday starts at 0." Starting this array at
// Sunday shifted the entire schedule by one day.
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// rashid_position.day is an integer 0-6 upstream and is mapped to weekday names,
// since an integer means nothing to a caller.
export const rashidScheduleSchema = z.array(z.object({
  day: z.string(), city: z.string().nullable(), location: z.string().nullable(),
  position: positionSchema,
}));

/**
 * One RASHID_SCHEDULE row as a `rashidScheduleSchema` entry. Every rashid_position column
 * is NOT NULL, so plain String and Number convert it: the null-aware converters live in
 * db.ts, which imports this module.
 */
export const rashidScheduleDay = (row: Record<string, unknown>) => ({
  day: WEEKDAYS[Number(row.day)] ?? String(row.day),
  city: String(row.city), location: String(row.location),
  position: { x: Number(row.x), y: Number(row.y), z: Number(row.z) },
});

/** A buyer's city and position, as `buyerPlace` reports them. */
export const buyerCitySchema = z.string().nullable().describe(RASHID_PLACE_MEANING);
export const buyerPositionSchema = positionSchema.describe(RASHID_PLACE_MEANING);

/** Where a buyer stands: its recorded city and position, or none for Rashid, who travels. */
export const buyerPlace = (npc: string, city: string | null, position: Position) =>
  npc === RASHID
    ? { city: null, position: { x: null, y: null, z: null } }
    : { city, position };

export const CREATURE_SORTS = ['experience', 'hitpoints', 'title', 'gold_per_kill'] as const;
export type CreatureSort = (typeof CREATURE_SORTS)[number];
/** gold_per_kill needs the query to select GOLD_PER_KILL's column under that name. */
const CREATURE_ORDER: Record<CreatureSort, string> = {
  experience: nullsLast('experience', 'desc'),
  hitpoints: nullsLast('nullif(hitpoints, 0)', 'desc'),
  title: 'title asc',
  gold_per_kill: nullsLast('gold_per_kill', 'desc'),
};
export function creatureSort(key: CreatureSort): string {
  if (!Object.hasOwn(CREATURE_ORDER, key)) {
    throw new Error(`Unknown sort key: ${String(key)}`);
  }
  return CREATURE_ORDER[key];
}

export const ITEM_SORTS = ['title', 'weight', 'value', 'armor', 'attack', 'defense'] as const;
export type ItemSort = (typeof ITEM_SORTS)[number];
/**
 * An item stat for ordering, read by leading integer as the numeric filters read it,
 * so "33 +3" ranks as 33. It is null for an item without the stat. The filters accept
 * any of an item's rows, so an item with two rows for a stat sorts by the larger, not
 * by whichever row comes first. The query must alias the item table `i`.
 */
const itemStat = (name: 'armor' | 'attack' | 'defense'): string =>
  `(select max(cast(a.value as integer)) from item_attribute a
     where a.item_id = i.article_id and a.name = '${name}')`;
const ITEM_ORDER: Record<ItemSort, string> = {
  title: 'title asc',
  weight: nullsLast('weight', 'asc'),
  value: nullsLast('value_buy', 'desc'),
  armor: nullsLast(itemStat('armor'), 'desc'),
  attack: nullsLast(itemStat('attack'), 'desc'),
  defense: nullsLast(itemStat('defense'), 'desc'),
};
export function itemSort(key: ItemSort): string {
  if (!Object.hasOwn(ITEM_ORDER, key)) {
    throw new Error(`Unknown sort key: ${String(key)}`);
  }
  return ITEM_ORDER[key];
}

// The spell table's vocation columns, each 0 or 1 and never null. This order is
// the order a spell's `vocations` lists them in.
export const SPELL_VOCATIONS = ['knight', 'sorcerer', 'druid', 'paladin', 'monk'] as const;
export type SpellVocation = (typeof SPELL_VOCATIONS)[number];
export function vocationColumn(vocation: SpellVocation): string {
  if (!SPELL_VOCATIONS.includes(vocation)) throw new Error(`Unknown vocation: ${String(vocation)}`);
  return vocation;
}

/**
 * The elements `spell.element` holds, lowercased. Healing, drown and lifedrain are
 * creature modifiers but no spell's element, so a healing spell is found by group.
 */
export const SPELL_ELEMENTS = [
  'death', 'earth', 'energy', 'fire', 'holy', 'ice', 'physical',
] as const satisfies readonly Element[];

/**
 * The values of `spell.group_spell` and `spell.spell_type`, lowercased like every
 * other input. The columns hold them capitalised, so they match with collate nocase.
 */
export const SPELL_GROUPS = ['attack', 'healing', 'support', 'conjure'] as const;
export const SPELL_TYPES = ['instant', 'rune'] as const;

export const SPELL_SORTS = ['level', 'mana', 'title'] as const;
export type SpellSort = (typeof SPELL_SORTS)[number];
const SPELL_ORDER: Record<SpellSort, string> = {
  level: nullsLast('level', 'asc'),
  mana: nullsLast('mana', 'asc'),
  title: 'title asc',
};
export function spellSort(key: SpellSort): string {
  if (!Object.hasOwn(SPELL_ORDER, key)) {
    throw new Error(`Unknown sort key: ${String(key)}`);
  }
  return SPELL_ORDER[key];
}

/**
 * A quest's rewards, as item titles, for `db.prepare` with the quest's article_id.
 * quest_reward holds some pairs twice (The Lightbearer's Ring of Healing), hence distinct.
 */
export const QUEST_REWARDS =
  `select distinct i.title from quest_reward r join item i on i.article_id = r.item_id
   where r.quest_id = ? order by i.title asc`;

export const QUEST_SORTS = ['level_recommended', 'level_required', 'title'] as const;
export type QuestSort = (typeof QUEST_SORTS)[number];
const QUEST_ORDER: Record<QuestSort, string> = {
  level_recommended: nullsLast('level_recommended', 'asc'),
  level_required: nullsLast('level_required', 'asc'),
  title: 'title asc',
};
export function questSort(key: QuestSort): string {
  if (!Object.hasOwn(QUEST_ORDER, key)) {
    throw new Error(`Unknown sort key: ${String(key)}`);
  }
  return QUEST_ORDER[key];
}

export const HOUSE_SORTS = ['rent', 'size', 'title'] as const;
export type HouseSort = (typeof HOUSE_SORTS)[number];
const HOUSE_ORDER: Record<HouseSort, string> = {
  rent: nullsLast('rent', 'asc'),
  size: nullsLast('size', 'desc'),
  title: 'title asc',
};
export function houseSort(key: HouseSort): string {
  if (!Object.hasOwn(HOUSE_ORDER, key)) {
    throw new Error(`Unknown sort key: ${String(key)}`);
  }
  return HOUSE_ORDER[key];
}

const EAV_OPERATORS = { gt: '>', gte: '>=', lte: '<=' } as const;
export type EavOperator = keyof typeof EAV_OPERATORS;
export function eavOperator(op: EavOperator): string {
  if (!Object.hasOwn(EAV_OPERATORS, op)) {
    throw new Error(`Unknown operator: ${String(op)}`);
  }
  return EAV_OPERATORS[op];
}

/**
 * Folds ASCII letters only, as SQLite's lower() and its nocase collation do, so text
 * compared in JS matches or sorts exactly as the SQL would.
 */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The pattern for `lower(column) like ? escape '\'`: the folded text as a literal
 * substring, so LIKE's wildcards and the escape character match themselves.
 */
export const likePattern = (text: string): string =>
  `%${asciiLower(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Titles as the nocase collation orders them, then exactly. */
export const titleOrder = (a: string, b: string): number => {
  const [fa, fb] = [asciiLower(a), asciiLower(b)];
  return fa < fb ? -1 : fa > fb ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** An item a name resolves to. */
export type ResolvedItem = { articleId: number; title: string };

/** The singular forms of one English plural word: -ies to -y, -ves to -f and -fe, -es and -s. */
function singularWords(word: string): string[] {
  const forms: string[] = [];
  if (word.endsWith('ies')) forms.push(`${word.slice(0, -3)}y`);
  if (word.endsWith('ves')) forms.push(`${word.slice(0, -3)}f`, `${word.slice(0, -3)}fe`);
  if (word.endsWith('es')) forms.push(word.slice(0, -2));
  if (word.endsWith('s')) forms.push(word.slice(0, -1));
  return forms;
}

/**
 * The singular forms of a plural name, made on the word just before " of " when the name
 * has one ("brown pieces of cloth" to "brown piece of cloth"), else on the last word.
 */
function singularForms(name: string): string[] {
  const of = name.indexOf(' of ');
  const head = of === -1 ? name : name.slice(0, of);
  const lead = head.slice(0, head.lastIndexOf(' ') + 1);
  const tail = of === -1 ? '' : name.slice(of);
  return singularWords(head.slice(lead.length)).map((word) => lead + word + tail);
}

/** An item a name could mean, and how the name matches it. */
type NameRow = ResolvedItem & {
  byTitle: boolean; byName: boolean; byPlural: boolean; bySingular: boolean;
  stackable: boolean; dropped: boolean;
};

/** An item as the name index holds it. */
type IndexedItem = ResolvedItem & { active: boolean; stackable: boolean };

/**
 * Every item under its folded title, whatever its status, and every active item under its
 * folded actual_name and plural. `dropsOf` gives a creature's dropped item ids, read from
 * the database on first use.
 */
type NameIndex = {
  titles: Map<string, IndexedItem[]>;
  names: Map<string, IndexedItem[]>;
  plurals: Map<string, IndexedItem[]>;
  dropsOf: (creatureId: number) => Set<number>;
};

/**
 * One name index per database handle, built on the first resolve. A query per name read
 * every item row, since a nocase match on three columns uses no index, and a loot paste
 * resolves hundreds of names. The index holds the database as it was when built, which is
 * the whole life of a read-only handle.
 */
const nameIndexes = new WeakMap<DatabaseSync, NameIndex>();

/** Adds `value` to `map` under the folded `key`, unless the key is null. */
function addFolded<T>(map: Map<string, T[]>, key: unknown, value: T): void {
  if (key === null) return;
  const folded = asciiLower(String(key));
  const list = map.get(folded);
  if (list) list.push(value);
  else map.set(folded, [value]);
}

function nameIndex(db: DatabaseSync): NameIndex {
  const cached = nameIndexes.get(db);
  if (cached) return cached;
  const titles = new Map<string, IndexedItem[]>();
  const names = new Map<string, IndexedItem[]>();
  const plurals = new Map<string, IndexedItem[]>();
  const rows = db.prepare(
    `select i.article_id, i.title, i.actual_name, i.plural, i.is_stackable,
            (${statusClause('i', false)}) as active
       from item i`).all();
  for (const r of rows) {
    const item: IndexedItem = {
      articleId: Number(r.article_id), title: String(r.title),
      active: r.active === 1, stackable: r.is_stackable === 1,
    };
    addFolded(titles, r.title, item);
    if (item.active) {
      addFolded(names, r.actual_name, item);
      addFolded(plurals, r.plural, item);
    }
  }
  const drops = new Map<number, Set<number>>();
  const dropRows = db.prepare('select item_id from creature_drop where creature_id = ?');
  const dropsOf = (creatureId: number): Set<number> => {
    let set = drops.get(creatureId);
    if (!set) {
      set = new Set(dropRows.all(creatureId).map((d) => Number(d.item_id)));
      drops.set(creatureId, set);
    }
    return set;
  };
  const index = { titles, names, plurals, dropsOf };
  nameIndexes.set(db, index);
  return index;
}

/** The rows `keep` accepts, or all of them when it accepts none. */
const narrow = (rows: NameRow[], keep: (row: NameRow) => boolean): NameRow[] => {
  const kept = rows.filter(keep);
  return kept.length > 0 ? kept : rows;
};

/** The first of `pools` that holds a row, or none. */
const firstFound = (...pools: NameRow[][]): NameRow[] => pools.find((p) => p.length > 0) ?? [];

/**
 * The item a name the game prints, or a wiki title, stands for. It returns one item for an
 * exact match, two or more candidates for a name several items share, and none for no
 * match, each by title. Unlike this module's SQL fragments, it reads `db` itself, through a
 * name index built once per database handle.
 *
 * With a `count` above 1, the name is a plural: the active items whose recorded plural it
 * is, or whose title or actual_name is one of its singular forms. When none is, it falls
 * back to the title, whatever the status, then actual_name. Then the items a creature in
 * `dropsOf` drops are kept, if any are, and of several the stackable ones, if any are.
 *
 * Otherwise, with `dropsOf`, the items with that title, actual_name or plural that a
 * creature in it drops. Failing that, the first step that finds anything: the title,
 * whatever the status (titles are unique), then the actual_name of active items, then
 * their plural, then the name read as a plural, as with a count above 1.
 *
 * `dropsOf` holds creature article ids: one creature, or each creature an ambiguous
 * creature name could mean. Names that begin with an article or a number are decorations,
 * not loot, and may resolve to nothing.
 */
export function resolveItemName(
  db: DatabaseSync,
  name: string,
  { count, dropsOf }: { count?: number; dropsOf?: ReadonlySet<number> } = {},
): ResolvedItem[] {
  const index = nameIndex(db);
  const folded = asciiLower(name);
  const counted = count !== undefined && count > 1;
  const singulars = singularForms(folded);
  const dropSets = [...(dropsOf ?? [])].map(index.dropsOf);
  // Each item a name could mean once, with every way the name matches it.
  const byId = new Map<number, NameRow>();
  type Flag = 'byTitle' | 'byName' | 'byPlural' | 'bySingular';
  const mark = (items: IndexedItem[] | undefined, flag: Flag) => {
    for (const item of items ?? []) {
      let row = byId.get(item.articleId);
      if (!row) {
        row = {
          articleId: item.articleId, title: item.title,
          byTitle: false, byName: false, byPlural: false, bySingular: false,
          stackable: item.stackable, dropped: dropSets.some((d) => d.has(item.articleId)),
        };
        byId.set(item.articleId, row);
      }
      row[flag] = true;
    }
  };
  mark(index.titles.get(folded), 'byTitle');
  mark(index.names.get(folded), 'byName');
  mark(index.plurals.get(folded), 'byPlural');
  for (const singular of singulars) {
    mark(index.titles.get(singular)?.filter((i) => i.active), 'bySingular');
    mark(index.names.get(singular), 'bySingular');
  }
  const rows = [...byId.values()];
  const byTitle = rows.filter((r) => r.byTitle);
  const byName = rows.filter((r) => r.byName);
  const byPlural = rows.filter((r) => r.byPlural);

  const asPlural = (): NameRow[] => {
    let pool = firstFound(rows.filter((r) => r.byPlural || r.bySingular), byTitle, byName);
    if (dropsOf) pool = narrow(pool, (r) => r.dropped);
    if (pool.length > 1) pool = narrow(pool, (r) => r.stackable);
    return pool;
  };

  let found: NameRow[];
  if (counted) {
    found = asPlural();
  } else {
    const dropped = dropsOf
      ? rows.filter((r) => r.dropped && (r.byTitle || r.byName || r.byPlural))
      : [];
    found = firstFound(dropped, byTitle, byName, byPlural);
    // A plural written without a count ("gold coins"), once nothing else matches.
    if (found.length === 0) found = asPlural();
  }
  return found
    .map(({ articleId, title }) => ({ articleId, title }))
    .sort((a, b) => titleOrder(a.title, b.title));
}

/** A creature a name resolves to. */
export type ResolvedCreature = { articleId: number; title: string };

/**
 * Every creature under its folded title, whatever its status, and every active creature
 * under its folded name and plural, one per database handle, as for items.
 */
const creatureIndexes = new WeakMap<DatabaseSync, Map<string, ResolvedCreature[]>[]>();

/**
 * The creature a name stands for: one for a match, two or more candidates for a name
 * several creatures share, none for no match, each by title. The first step that finds
 * anything wins: the title, whatever the status, then the name of active creatures, then
 * their plural, all compared case-insensitively.
 */
export function resolveCreatureName(db: DatabaseSync, name: string): ResolvedCreature[] {
  let steps = creatureIndexes.get(db);
  if (!steps) {
    const titles = new Map<string, ResolvedCreature[]>();
    const names = new Map<string, ResolvedCreature[]>();
    const plurals = new Map<string, ResolvedCreature[]>();
    const rows = db.prepare(
      `select c.article_id, c.title, c.name, c.plural, (${statusClause('c', false)}) as active
         from creature c`).all();
    for (const r of rows) {
      const creature = { articleId: Number(r.article_id), title: String(r.title) };
      addFolded(titles, r.title, creature);
      if (r.active === 1) {
        addFolded(names, r.name, creature);
        addFolded(plurals, r.plural, creature);
      }
    }
    steps = [titles, names, plurals];
    creatureIndexes.set(db, steps);
  }
  const folded = asciiLower(name);
  const found = steps.map((step) => step.get(folded) ?? []).find((f) => f.length > 0) ?? [];
  return [...found].sort((a, b) => titleOrder(a.title, b.title));
}

/**
 * Non-active rows are numerous (138 event, 45 unavailable, 39 deprecated creatures)
 * and must not surface as live answers. The alias is mandatory: every query in this
 * server joins at least two tables carrying a `status` column, and an unqualified
 * predicate fails at runtime with "ambiguous column name: status".
 */
export function statusClause(alias: string, includeInactive: boolean): string {
  return includeInactive ? '' : `${alias}.status = 'active'`;
}

export const verbositySchema = z.enum(['concise', 'detailed']).default('concise');

/** Real columns, verified against the generated database. */
export const DETAILED_CREATURE_FIELDS = [
  'location', 'spawn_type', 'mitigation', 'bestiary_occurrence',
  'walks_through', 'walks_around',
] as const;
export const DETAILED_ITEM_FIELDS = ['flavor_text'] as const;

/**
 * Item stats live in `item_attribute` as TEXT, and the "numeric" ones are not always
 * integers: three active items carry a bonus suffix, e.g. Moonsilver Axe has
 * `defense = "33 +3"`. `Number()` turns those into NaN, which the tools' outputSchema
 * rejects, failing the whole call. So coercion is best-effort: a clean integer becomes
 * a number, anything else is returned verbatim, which is also more informative.
 * Resistances and skill bonuses are signed, "-8" or "+2", and `Number()` reads the sign.
 *
 * SQL filtering is unaffected and stays consistent - SQLite's
 * `cast('33 +3' as integer)` is 33, so `defense_min: 33` still matches.
 */
export const NUMERIC_ATTRS: readonly string[] = [
  'attack', 'defense', 'armor', 'required_level', 'imbuement_slots',
  ...Object.values(RESISTANCE_ATTRS), ...ITEM_SKILLS,
];

export const REPORTED_ATTRS: ReadonlySet<string> = new Set<string>([
  ...NUMERIC_ATTRS, 'required_vocation', 'weapon_type', 'hands',
]);

export function coerceAttribute(name: string, value: unknown): string | number {
  const raw = String(value);
  if (!NUMERIC_ATTRS.includes(name)) return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

/**
 * `hitpoints = 0` means "the wiki does not record it", not "this creature has no
 * health" - 34 creatures carry 0 hp alongside a real experience value, including
 * Phosphorus (Final) at 16,000,000 exp. Left as-is, `hitpoints_max: 100` matches
 * 637 creatures of which most are unknowns; through nullif it matches 204 real ones.
 *
 * `experience = 0` is deliberately NOT treated this way: 295 creatures have real
 * hitpoints and genuinely award no experience (Morshabaal and friends), so a zero
 * there is data, not a gap.
 */
export function hitpointsExpr(alias: string): string {
  return `nullif(${alias}.hitpoints, 0)`;
}
