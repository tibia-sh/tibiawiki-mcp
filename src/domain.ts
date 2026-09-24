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
 * The elements an item can resist: every element but healing, which no item resists.
 * An item's resistance is a percentage in `item_attribute`, where above 0 protects and
 * below 0 is a weakness. Two elements go by other names there.
 */
export const ITEM_RESISTANCES = [
  'physical', 'earth', 'fire', 'ice', 'energy', 'death', 'holy', 'drown', 'lifedrain',
] as const satisfies readonly Element[];
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

/** The values of the `hands` attribute. */
export const ITEM_HANDS = ['One', 'Two'] as const;

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

export const CREATURE_SORTS = ['experience', 'hitpoints', 'title'] as const;
export type CreatureSort = (typeof CREATURE_SORTS)[number];
const CREATURE_ORDER: Record<CreatureSort, string> = {
  // Nulls last, with title as a tiebreak so pagination is stable.
  experience: '(experience is null), experience desc, title asc',
  hitpoints: '(nullif(hitpoints, 0) is null), nullif(hitpoints, 0) desc, title asc',
  title: 'title asc',
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
const statOrder = (name: 'armor' | 'attack' | 'defense'): string =>
  `(${itemStat(name)} is null), ${itemStat(name)} desc, title asc`;
const ITEM_ORDER: Record<ItemSort, string> = {
  title: 'title asc',
  weight: '(weight is null), weight asc, title asc',
  value: '(value_buy is null), value_buy desc, title asc',
  armor: statOrder('armor'),
  attack: statOrder('attack'),
  defense: statOrder('defense'),
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
  level: '(level is null), level asc, title asc',
  mana: '(mana is null), mana asc, title asc',
  title: 'title asc',
};
export function spellSort(key: SpellSort): string {
  if (!Object.hasOwn(SPELL_ORDER, key)) {
    throw new Error(`Unknown sort key: ${String(key)}`);
  }
  return SPELL_ORDER[key];
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
 * Item stats live in `item_attribute` as TEXT, and the five "numeric" ones are not
 * always integers: three active items carry a bonus suffix, e.g. Moonsilver Axe has
 * `defense = "33 +3"`. `Number()` turns those into NaN, which the tools' outputSchema
 * rejects, failing the whole call. So coercion is best-effort: a clean integer becomes
 * a number, anything else is returned verbatim, which is also more informative.
 *
 * SQL filtering is unaffected and stays consistent - SQLite's
 * `cast('33 +3' as integer)` is 33, so `defense_min: 33` still matches.
 */
export const NUMERIC_ATTRS = [
  'attack', 'defense', 'armor', 'required_level', 'imbuement_slots',
] as const;

export const REPORTED_ATTRS: ReadonlySet<string> = new Set<string>([
  ...NUMERIC_ATTRS, 'required_vocation', 'weapon_type', 'hands',
  ...Object.values(RESISTANCE_ATTRS), ...ITEM_SKILLS,
]);

export function coerceAttribute(name: string, value: unknown): string | number {
  const raw = String(value);
  if (!(NUMERIC_ATTRS as readonly string[]).includes(name)) return raw;
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
