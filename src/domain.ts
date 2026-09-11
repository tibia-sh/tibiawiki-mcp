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

export const ENTITY_TYPES = ['creature', 'item', 'npc', 'quest', 'spell'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const entityTypeSchema = z.enum(ENTITY_TYPES);

const SEARCH_TABLES: Record<EntityType, string> = {
  creature: 'creature', item: 'item', npc: 'npc', quest: 'quest', spell: 'spell',
};
export function searchTable(type: EntityType): string {
  const t = SEARCH_TABLES[type];
  if (!t) throw new Error(`Unknown entity type: ${String(type)}`);
  return t;
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
  const s = CREATURE_ORDER[key];
  if (!s) throw new Error(`Unknown sort key: ${String(key)}`);
  return s;
}

export const ITEM_SORTS = ['title', 'weight', 'value'] as const;
export type ItemSort = (typeof ITEM_SORTS)[number];
const ITEM_ORDER: Record<ItemSort, string> = {
  title: 'title asc',
  weight: '(weight is null), weight asc, title asc',
  value: '(value_buy is null), value_buy desc, title asc',
};
export function itemSort(key: ItemSort): string {
  const s = ITEM_ORDER[key];
  if (!s) throw new Error(`Unknown sort key: ${String(key)}`);
  return s;
}

const EAV_OPERATORS = { gte: '>=', lte: '<=' } as const;
export type EavOperator = keyof typeof EAV_OPERATORS;
export function eavOperator(op: EavOperator): string {
  const s = EAV_OPERATORS[op];
  if (!s) throw new Error(`Unknown operator: ${String(op)}`);
  return s;
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
