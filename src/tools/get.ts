import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Provenance, TibiaDb } from '../db.ts';
import {
  ELEMENTS, ENTITY_TYPES, entityTypeSchema, searchTable, statusClause, verbositySchema,
  DETAILED_CREATURE_FIELDS, DETAILED_ITEM_FIELDS, coerceAttribute, type EntityType,
} from '../domain.ts';

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function sourceBlock(title: string, p: Provenance) {
  return {
    page: title,
    url: `https://tibia.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    indexGeneratedAt: p.generatedAt,
  };
}

const sourceSchema = z.object({
  page: z.string(), url: z.string(), indexGeneratedAt: z.string(),
});
const detail = z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional();

const creatureOut = z.object({
  type: z.literal('creature'),
  title: z.string(),
  hitpoints: z.number().nullable(),
  experience: z.number().nullable(),
  armor: z.number().nullable(),
  speed: z.number().nullable(),
  bestiaryClass: z.string().nullable(),
  isBoss: z.boolean(),
  status: z.string().nullable(),
  modifiers: z.record(z.string(), z.number().nullable()),
  loot: z.array(z.object({
    item: z.string(),
    chance: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
  })),
  detail, source: sourceSchema,
});
const itemOut = z.object({
  type: z.literal('item'),
  title: z.string(),
  itemClass: z.string().nullable(),
  itemType: z.string().nullable(),
  typeSecondary: z.string().nullable(),
  weight: z.number().nullable(),
  valueBuy: z.number().nullable(),
  valueSell: z.number().nullable(),
  isMarketable: z.boolean().nullable(),
  status: z.string().nullable(),
  attributes: z.record(z.string(), z.union([z.string(), z.number()])),
  detail, source: sourceSchema,
});
const npcOut = z.object({
  type: z.literal('npc'),
  title: z.string(),
  gender: z.string().nullable(),
  city: z.string().nullable(),
  subarea: z.string().nullable(),
  location: z.string().nullable(),
  position: z.object({
    x: z.number().nullable(), y: z.number().nullable(), z: z.number().nullable(),
  }),
  status: z.string().nullable(),
  detail, source: sourceSchema,
});
const questOut = z.object({
  type: z.literal('quest'),
  title: z.string(),
  location: z.string().nullable(),
  levelRequired: z.number().nullable(),
  levelRecommended: z.number().nullable(),
  isPremium: z.boolean().nullable(),
  questLog: z.string().nullable(),
  legend: z.string().nullable(),
  status: z.string().nullable(),
  detail, source: sourceSchema,
});
const spellOut = z.object({
  type: z.literal('spell'),
  title: z.string(),
  words: z.string().nullable(),
  spellType: z.string().nullable(),
  element: z.string().nullable(),
  mana: z.number().nullable(),
  level: z.number().nullable(),
  soul: z.number().nullable(),
  isPremium: z.boolean().nullable(),
  cooldown: z.number().nullable(),
  status: z.string().nullable(),
  detail, source: sourceSchema,
});

const outputSchema = z.discriminatedUnion('type', [
  creatureOut, itemOut, npcOut, questOut, spellOut,
]);

export const NAME = 'tibia_get';

export function registerGet(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  // spell.title is the one identity column without COLLATE NOCASE, so every lookup
  // states the collation explicitly rather than relying on the column's default.
  const lookup = (type: EntityType, includeInactive: boolean) => {
    const status = statusClause('t', includeInactive);
    // Table name goes through the closed map in domain.ts, so the type system -
    // not just the call site - guarantees nothing else can reach the query.
    return db.prepare(
      `select * from "${searchTable(type)}" t where t.title = ? collate nocase` +
        (status ? ` and ${status}` : ''),
    );
  };
  const drops = db.prepare(
    `select i.title as item, d.chance, d.min as lo, d.max as hi
     from creature_drop d join item i on i.article_id = d.item_id
     where d.creature_id = ?
     order by (d.chance is null), d.chance asc, i.title asc`,
  );
  const attrs = db.prepare('select name, value from item_attribute where item_id = ?');

  const shape = (type: EntityType, row: Row, verbosity: 'concise' | 'detailed') => {
    const title = String(row.title);
    const source = sourceBlock(title, provenance);
    const withDetail = <T extends object>(base: T, fields: readonly string[]): T =>
      verbosity === 'detailed'
        ? { ...base, detail: Object.fromEntries(fields.map((f) => [f, str(row[f])])) }
        : base;

    switch (type) {
      case 'creature':
        return withDetail({
          type: 'creature' as const, title,
          // 0 means unrecorded (see hitpointsExpr in domain.ts), so report null.
          hitpoints: row.hitpoints ? num(row.hitpoints) : null,
          experience: num(row.experience),
          armor: num(row.armor), speed: num(row.speed),
          bestiaryClass: str(row.bestiary_class), isBoss: Boolean(row.is_boss),
          status: str(row.status),
          modifiers: Object.fromEntries(ELEMENTS.map((e) => [e, num(row[`modifier_${e}`])])),
          loot: drops.all(row.article_id as number).map((d) => ({
            item: String(d.item), chance: num(d.chance), min: num(d.lo), max: num(d.hi),
          })),
          source,
        }, DETAILED_CREATURE_FIELDS);
      case 'item': {
        const bag: Record<string, string | number> = {};
        for (const a of attrs.all(row.article_id as number)) {
          const key = String(a.name);
          bag[key] = coerceAttribute(key, a.value);
        }
        return withDetail({
          type: 'item' as const, title,
          itemClass: str(row.item_class), itemType: str(row.item_type),
          typeSecondary: str(row.type_secondary), weight: num(row.weight),
          valueBuy: num(row.value_buy), valueSell: num(row.value_sell),
          isMarketable: row.is_marketable === null ? null : Boolean(row.is_marketable),
          status: str(row.status), attributes: bag, source,
        }, DETAILED_ITEM_FIELDS);
      }
      case 'npc':
        return {
          type: 'npc' as const, title, gender: str(row.gender), city: str(row.city),
          subarea: str(row.subarea), location: str(row.location),
          position: { x: num(row.x), y: num(row.y), z: num(row.z) },
          status: str(row.status), source,
        };
      case 'quest':
        return {
          type: 'quest' as const, title, location: str(row.location),
          levelRequired: num(row.level_required), levelRecommended: num(row.level_recommended),
          isPremium: row.is_premium === null ? null : Boolean(row.is_premium),
          questLog: str(row.quest_log), legend: str(row.legend),
          status: str(row.status), source,
        };
      case 'spell':
        return {
          type: 'spell' as const, title, words: str(row.words),
          spellType: str(row.spell_type), element: str(row.element),
          mana: num(row.mana), level: num(row.level), soul: num(row.soul),
          isPremium: row.is_premium === null ? null : Boolean(row.is_premium),
          cooldown: num(row.cooldown), status: str(row.status), source,
        };
    }
  };

  server.registerTool(
    NAME,
    {
      description:
        'Full detail for one named Tibia page: a creature (with its complete loot table and ' +
        'drop chances), item, NPC, quest or spell. Look up by exact page name; use tibia_search ' +
        'first if the name is uncertain. Pass `type` to disambiguate a name used by two kinds of page.',
      inputSchema: z.object({
        name: z.string().min(1).describe('Page name, e.g. "Dragon Lord". Case-insensitive.'),
        type: entityTypeSchema.optional().describe('Restrict the lookup to one kind of page.'),
        include_inactive: z.boolean().default(false)
          .describe('Include deprecated, event-only and unavailable pages. Applies to the requested page.'),
        verbosity: verbositySchema.describe('"detailed" adds extra descriptive columns.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name, type, include_inactive, verbosity }) => {
      const candidates = type ? [type] : ENTITY_TYPES;
      const hits: Array<{ type: EntityType; row: Row }> = [];
      for (const t of candidates) {
        const row = lookup(t, include_inactive).get(name) as Row | undefined;
        if (row) hits.push({ type: t, row });
      }

      if (hits.length === 0) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `No page named "${name}" in the index. Use tibia_search to find the exact ` +
              'page name, or pass include_inactive: true if it may be a deprecated or event page.',
          }],
        };
      }
      if (hits.length > 1) {
        const types = hits.map((h) => h.type).join(', ');
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `"${name}" is ambiguous — it exists as: ${types}. ` +
              'Call tibia_get again with the `type` argument set to the one you want.',
          }],
        };
      }

      const hit = hits[0]!;
      const output = shape(hit.type, hit.row, verbosity);
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
