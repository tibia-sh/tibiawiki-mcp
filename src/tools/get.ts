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
  abilities: z.array(z.object({
    name: z.string(),
    effect: z.string().nullable(),
    element: z.string().nullable(),
  })),
  maxDamage: z.record(z.string(), z.number().nullable()).nullable(),
  sounds: z.array(z.string()),
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
  // item_key is one-to-many (Silver Key has 61 rows) and each row is a full key
  // article with its own number, material and location.
  keys: z.array(z.object({
    title: z.string(), number: z.number().nullable(), name: z.string().nullable(),
    material: z.string().nullable(), location: z.string().nullable(), notes: z.string().nullable(),
  })),
  storeOffers: z.array(z.object({
    price: z.number().nullable(), amount: z.number().nullable(), currency: z.string().nullable(),
  })),
  proficiencyPerks: z.array(z.object({
    level: z.number().nullable(), effect: z.string().nullable(), skill: z.string().nullable(),
  })),
  sounds: z.array(z.string()),
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
  jobs: z.array(z.string()),
  races: z.array(z.string()),
  destinations: z.array(z.object({
    name: z.string(), price: z.number().nullable(), notes: z.string().nullable(),
  })),
  // Only Rashid has one; rashid_position.day is an integer 0-6 upstream and is
  // mapped to weekday names here, since an integer means nothing to a caller.
  rashidSchedule: z.array(z.object({
    day: z.string(), city: z.string().nullable(), location: z.string().nullable(),
    position: z.object({
      x: z.number().nullable(), y: z.number().nullable(), z: z.number().nullable(),
    }),
  })).optional(),
  detail, source: sourceSchema,
});
const questOut = z.object({
  type: z.literal('quest'),
  title: z.string(),
  location: z.string().nullable(),
  levelRequired: z.number().nullable(),
  levelRecommended: z.number().nullable(),
  isPremium: z.boolean().nullable(),
  questLog: z.boolean().nullable(),
  legend: z.string().nullable(),
  status: z.string().nullable(),
  // quest_danger stores creature_id; these are joined to names to be usable.
  dangers: z.array(z.string()),
  rewards: z.array(z.string()),
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
  materials: z.array(z.object({ item: z.string(), amount: z.number().nullable() })),
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
  quests: z.array(z.object({ quest: z.string(), unlockType: z.string().nullable() })),
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
  battleye: z.boolean().nullable(),
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

  // Every detail query orders on real columns and is a TOTAL order. Implicit rowid
  // order is not safe: these are plain rowid tables, and make-fixture.mjs runs
  // VACUUM, which SQLite may use to renumber rowids.
  const abilities = db.prepare(
    `select name, effect, element from creature_ability where creature_id = ?
     order by name asc, effect asc, element asc`);
  const maxDamage = db.prepare('select * from creature_max_damage where creature_id = ?');
  const creatureSounds = db.prepare(
    'select content from creature_sound where creature_id = ? order by content asc');
  const itemKeys = db.prepare(
    `select title, number, name, material, location, notes from item_key where item_id = ?
     order by number asc, title asc`);
  const storeOffers = db.prepare(
    `select price, amount, currency from item_store_offer where item_id = ?
     order by price asc, amount asc`);
  const perks = db.prepare(
    `select proficiency_level, effect, skill_image from item_proficiency_perk where item_id = ?
     order by proficiency_level asc, effect asc`);
  const itemSounds = db.prepare(
    'select content from item_sound where item_id = ? order by content asc');
  const npcJobs = db.prepare('select name from npc_job where npc_id = ? order by name asc');
  const npcRaces = db.prepare('select name from npc_race where npc_id = ? order by name asc');
  const destinations = db.prepare(
    `select name, price, notes from npc_destination where npc_id = ?
     order by name asc, price asc`);
  const rashid = db.prepare('select day, city, location, x, y, z from rashid_position order by day asc');
  const dangers = db.prepare(
    `select c.title from quest_danger d join creature c on c.article_id = d.creature_id
     where d.quest_id = ? order by c.title asc`);
  const questRewards = db.prepare(
    `select i.title from quest_reward r join item i on i.article_id = r.item_id
     where r.quest_id = ? order by i.title asc`);
  const materials = db.prepare(
    `select i.title, m.amount from imbuement_material m join item i on i.article_id = m.item_id
     where m.imbuement_id = ? order by i.title asc`);
  const outfitQuests = db.prepare(
    // Total order: Assassin Outfits has two rows for the same quest title,
    // distinguished only by unlock_type ('outfit' and 'addons').
    `select q.title, oq.unlock_type from outfit_quest oq join quest q on q.article_id = oq.quest_id
     where oq.outfit_id = ? order by q.title asc, oq.unlock_type asc`);

  // tibiawiki-sql: "Day of the week, Monday starts at 0." Starting this array at
  // Sunday shifted the entire schedule by one day.
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAMAGE_KEYS = [
    ...ELEMENTS, 'manadrain', 'summons', 'total',
  ] as const;

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
          abilities: abilities.all(row.article_id as number).map((a) => ({
            name: String(a.name), effect: str(a.effect), element: str(a.element),
          })),
          maxDamage: (() => {
            const m = maxDamage.get(row.article_id as number) as Row | undefined;
            return m ? Object.fromEntries(DAMAGE_KEYS.map((k) => [k, num(m[k])])) : null;
          })(),
          sounds: creatureSounds.all(row.article_id as number).map((r) => String(r.content)),
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
          status: str(row.status), attributes: bag,
          keys: itemKeys.all(row.article_id as number).map((k) => ({
            title: String(k.title), number: num(k.number), name: str(k.name),
            material: str(k.material), location: str(k.location), notes: str(k.notes),
          })),
          storeOffers: storeOffers.all(row.article_id as number).map((o) => ({
            price: num(o.price), amount: num(o.amount), currency: str(o.currency),
          })),
          proficiencyPerks: perks.all(row.article_id as number).map((p) => ({
            level: num(p.proficiency_level), effect: str(p.effect), skill: str(p.skill_image),
          })),
          sounds: itemSounds.all(row.article_id as number).map((r) => String(r.content)),
          source,
        }, DETAILED_ITEM_FIELDS);
      }
      case 'npc':
        return {
          type: 'npc' as const, title, gender: str(row.gender), city: str(row.city),
          subarea: str(row.subarea), location: str(row.location),
          position: { x: num(row.x), y: num(row.y), z: num(row.z) },
          status: str(row.status),
          jobs: npcJobs.all(row.article_id as number).map((r) => String(r.name)),
          races: npcRaces.all(row.article_id as number).map((r) => String(r.name)),
          destinations: destinations.all(row.article_id as number).map((d) => ({
            name: String(d.name), price: num(d.price), notes: str(d.notes),
          })),
          ...(title === 'Rashid'
            ? {
                rashidSchedule: rashid.all().map((r) => ({
                  day: WEEKDAYS[Number(r.day)] ?? String(r.day),
                  city: str(r.city), location: str(r.location),
                  position: { x: num(r.x), y: num(r.y), z: num(r.z) },
                })),
              }
            : {}),
          source,
        };
      case 'quest':
        return {
          type: 'quest' as const, title, location: str(row.location),
          levelRequired: num(row.level_required), levelRecommended: num(row.level_recommended),
          isPremium: row.is_premium === null ? null : Boolean(row.is_premium),
          questLog: bool(row.quest_log), legend: str(row.legend),
          status: str(row.status),
          dangers: dangers.all(row.article_id as number).map((r) => String(r.title)),
          rewards: questRewards.all(row.article_id as number).map((r) => String(r.title)),
          source,
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
          status: str(row.status),
          materials: materials.all(row.article_id as number).map((m) => ({
            item: String(m.title), amount: num(m.amount),
          })),
          source,
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
          achievement: str(row.achievement), status: str(row.status),
          quests: outfitQuests.all(row.article_id as number).map((q) => ({
            quest: String(q.title), unlockType: str(q.unlock_type),
          })),
          source,
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
          mergedInto: str(row.merged_into), battleye: bool(row.battleye),
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
        'Full detail for one named Tibia page of any kind: creature (with its loot table, ' +
        'abilities and max damage), item, npc, quest, spell, achievement, house, imbuement, ' +
        'charm, mount, outfit, book, world or update. Takes an exact page name — use ' +
        'tibia_search first if it is uncertain. Pass `type` to disambiguate a shared name.',
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
