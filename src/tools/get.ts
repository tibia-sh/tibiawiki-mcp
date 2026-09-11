import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Provenance, TibiaDb } from '../db.ts';
import {
  ELEMENTS, ENTITY_TYPES, entityTypeSchema, entityTable, entityHasStatus, statusClause,
  verbositySchema,
  DETAILED_CREATURE_FIELDS, DETAILED_ITEM_FIELDS, coerceAttribute, type EntityType,
} from '../domain.ts';

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));

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

const achievementOut = z.object({
  type: z.literal('achievement'),
  title: z.string(),
  grade: z.number().nullable(),
  points: z.number().nullable(),
  description: z.string().nullable(),
  spoiler: z.string().nullable(),
  isSecret: z.boolean().nullable(),
  isPremium: z.boolean().nullable(),
  achievementId: z.number().nullable(),
  status: z.string().nullable(),
  detail, source: sourceSchema,
});
const houseOut = z.object({
  type: z.literal('house'),
  title: z.string(),
  houseId: z.number().nullable(),
  city: z.string().nullable(),
  street: z.string().nullable(),
  location: z.string().nullable(),
  beds: z.number().nullable(),
  rent: z.number().nullable(),
  size: z.number().nullable(),
  rooms: z.number().nullable(),
  floors: z.number().nullable(),
  position: z.object({
    x: z.number().nullable(), y: z.number().nullable(), z: z.number().nullable(),
  }),
  isGuildhall: z.boolean().nullable(),
  status: z.string().nullable(),
  detail, source: sourceSchema,
});
const imbuementOut = z.object({
  type: z.literal('imbuement'),
  title: z.string(),
  tier: z.string().nullable(),
  category: z.string().nullable(),
  imbuementType: z.string().nullable(),
  effect: z.string().nullable(),
  // NOT a count: imbuement.slots is TEXT holding the equipment categories the
  // imbuement applies to, e.g. "swords,clubs,axes,bows,crossbows".
  slots: z.array(z.string()),
  status: z.string().nullable(),
  detail, source: sourceSchema,
});
const charmOut = z.object({
  type: z.literal('charm'),
  title: z.string(),
  charmType: z.string().nullable(),
  effect: z.string().nullable(),
  costs: z.array(z.number().nullable()),
  status: z.string().nullable(),
  detail, source: sourceSchema,
});
const mountOut = z.object({
  type: z.literal('mount'),
  title: z.string(),
  speed: z.number().nullable(),
  tamingMethod: z.string().nullable(),
  isBuyable: z.boolean().nullable(),
  price: z.number().nullable(),
  achievement: z.string().nullable(),
  lightColor: z.number().nullable(),
  lightRadius: z.number().nullable(),
  status: z.string().nullable(),
  detail, source: sourceSchema,
});
const outfitOut = z.object({
  type: z.literal('outfit'),
  title: z.string(),
  outfitType: z.string().nullable(),
  isPremium: z.boolean().nullable(),
  isBought: z.boolean().nullable(),
  isTournament: z.boolean().nullable(),
  fullPrice: z.number().nullable(),
  achievement: z.string().nullable(),
  status: z.string().nullable(),
  detail, source: sourceSchema,
});
const bookOut = z.object({
  type: z.literal('book'),
  title: z.string(),
  bookType: z.string().nullable(),
  itemId: z.number().nullable(),
  location: z.string().nullable(),
  blurb: z.string().nullable(),
  author: z.string().nullable(),
  prevBook: z.string().nullable(),
  nextBook: z.string().nullable(),
  text: z.string().nullable().optional(),   // detailed only: the heaviest column
  status: z.string().nullable(),
  detail, source: sourceSchema,
});
const worldOut = z.object({
  type: z.literal('world'),
  title: z.string(),
  location: z.string().nullable(),
  pvpType: z.string().nullable(),
  isPreview: z.boolean().nullable(),
  isExperimental: z.boolean().nullable(),
  onlineSince: z.string().nullable(),
  offlineSince: z.string().nullable(),
  mergedInto: z.string().nullable(),
  battleye: z.string().nullable(),
  battleyeType: z.string().nullable(),
  protectedSince: z.string().nullable(),
  worldBoard: z.number().nullable(),
  tradeBoard: z.number().nullable(),
  detail, source: sourceSchema,       // no status column on this table
});
const updateOut = z.object({
  type: z.literal('update'),
  title: z.string(),
  releaseDate: z.string().nullable(),
  newsId: z.number().nullable(),
  typePrimary: z.string().nullable(),
  typeSecondary: z.string().nullable(),
  previous: z.string().nullable(),
  next: z.string().nullable(),
  summary: z.string().nullable(),
  changes: z.string().nullable(),
  detail, source: sourceSchema,       // no status column on this table
});

const outputSchema = z.discriminatedUnion('type', [
  creatureOut, itemOut, npcOut, questOut, spellOut,
  achievementOut, houseOut, imbuementOut, charmOut, mountOut, outfitOut, bookOut,
  worldOut, updateOut,
]);

export const NAME = 'tibia_get';

export function registerGet(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  // Not every identity column declares COLLATE NOCASE - spell, imbuement and book
  // are plain TEXT UNIQUE - so every lookup states the collation explicitly rather
  // than relying on the column's default.
  const lookup = (type: EntityType, includeInactive: boolean) => {
    // Omitted entirely for world/update, which have no status column.
    const status = entityHasStatus(type) ? statusClause('t', includeInactive) : '';
    // Table name goes through the closed map in domain.ts, so the type system -
    // not just the call site - guarantees nothing else can reach the query.
    return db.prepare(
      `select * from "${entityTable(type)}" t where t.title = ? collate nocase` +
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
      case 'achievement':
        return {
          type: 'achievement' as const, title, grade: num(row.grade),
          points: num(row.points), description: str(row.description),
          spoiler: str(row.spoiler), isSecret: bool(row.is_secret),
          isPremium: bool(row.is_premium), achievementId: num(row.achievement_id),
          status: str(row.status), source,
        };
      case 'house':
        return {
          type: 'house' as const, title, houseId: num(row.house_id),
          city: str(row.city), street: str(row.street), location: str(row.location),
          beds: num(row.beds), rent: num(row.rent), size: num(row.size),
          rooms: num(row.rooms), floors: num(row.floors),
          position: { x: num(row.x), y: num(row.y), z: num(row.z) },
          isGuildhall: bool(row.is_guildhall), status: str(row.status), source,
        };
      case 'imbuement':
        return {
          type: 'imbuement' as const, title, tier: str(row.tier),
          category: str(row.category), imbuementType: str(row.type),
          effect: str(row.effect),
          slots: str(row.slots)?.split(',').map((x) => x.trim()).filter(Boolean) ?? [],
          status: str(row.status), source,
        };
      case 'charm':
        return {
          type: 'charm' as const, title, charmType: str(row.type),
          effect: str(row.effect),
          costs: [num(row.cost_level_1), num(row.cost_level_2), num(row.cost_level_3)],
          status: str(row.status), source,
        };
      case 'mount':
        return {
          type: 'mount' as const, title, speed: num(row.speed),
          tamingMethod: str(row.taming_method), isBuyable: bool(row.is_buyable),
          price: num(row.price), achievement: str(row.achievement),
          lightColor: num(row.light_color), lightRadius: num(row.light_radius),
          status: str(row.status), source,
        };
      case 'outfit':
        return {
          type: 'outfit' as const, title, outfitType: str(row.outfit_type),
          isPremium: bool(row.is_premium), isBought: bool(row.is_bought),
          isTournament: bool(row.is_tournament), fullPrice: num(row.full_price),
          achievement: str(row.achievement), status: str(row.status), source,
        };
      case 'book':
        return {
          type: 'book' as const, title, bookType: str(row.book_type),
          itemId: num(row.item_id), location: str(row.location),
          blurb: str(row.blurb), author: str(row.author),
          prevBook: str(row.prev_book), nextBook: str(row.next_book),
          // book.text is the heaviest column in the corpus (1,226 rows), so it is
          // gated behind detailed verbosity rather than sent on every lookup.
          ...(verbosity === 'detailed' ? { text: str(row.text) } : {}),
          status: str(row.status), source,
        };
      case 'world':
        return {
          type: 'world' as const, title, location: str(row.location),
          pvpType: str(row.pvp_type), isPreview: bool(row.is_preview),
          isExperimental: bool(row.is_experimental),
          onlineSince: str(row.online_since), offlineSince: str(row.offline_since),
          mergedInto: str(row.merged_into), battleye: str(row.battleye),
          battleyeType: str(row.battleye_type), protectedSince: str(row.protected_since),
          worldBoard: num(row.world_board), tradeBoard: num(row.trade_board), source,
        };
      case 'update':
        return {
          type: 'update' as const, title, releaseDate: str(row.release_date),
          newsId: num(row.news_id), typePrimary: str(row.type_primary),
          typeSecondary: str(row.type_secondary), previous: str(row.previous),
          next: str(row.next), summary: str(row.summary), changes: str(row.changes),
          source,
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
