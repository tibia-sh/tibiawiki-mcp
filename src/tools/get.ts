import { z } from 'zod';
import { renderArea, renderSpellShape, AREA_LEGEND } from '../area.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import { str, num, bool, type Provenance, type TibiaDb } from '../db.ts';
import {
  ELEMENTS, ENTITY_TYPES, entityTypeSchema, entityTable, entityHasStatus, statusClause,
  verbositySchema, SPELL_VOCATIONS, QUEST_REWARDS,
  DETAILED_CREATURE_FIELDS, DETAILED_ITEM_FIELDS, coerceAttribute, type EntityType,
  runsAtSchema, summonCostSchema, convinceCostSchema,
} from '../domain.ts';

type Row = Record<string, unknown>;

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
const tradeSchema = z.array(z.object({ item: z.string(), price: z.number(), currency: z.string() }));

/**
 * Linked, never stored. `width`/`height` are the sprite image's pixel size - NOT a
 * tile footprint: 80% of creature images are 64x64 while nearly every creature
 * occupies one square. Any describe() text here is emitted once per entity type.
 */
const imageSchema = z.object({
  fileName: z.string(),
  url: z.string(),
  descriptionUrl: z.string(),
  width: z.number(),
  height: z.number(),
  mimeType: z.string(),
}).nullable().describe('Sprite image link. Dimensions are pixels, not map squares.');

const creatureOut = z.object({
  type: z.literal('creature'),
  image: imageSchema,
  title: z.string(),
  hitpoints: z.number().nullable(),
  experience: z.number().nullable(),
  armor: z.number().nullable(),
  speed: z.number().nullable(),
  bestiaryClass: z.string().nullable(),
  bestiaryLevel: z.string().nullable(),
  isBoss: z.boolean(),
  status: z.string().nullable(),
  runsAt: runsAtSchema,
  seesInvisible: z.boolean().nullable(),
  paralysable: z.boolean().nullable(),
  pushable: z.boolean().nullable(),
  pushObjects: z.boolean().nullable(),
  illusionable: z.boolean().nullable(),
  summonCost: summonCostSchema,
  convinceCost: convinceCostSchema,
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
    area: z.object({
      key: z.string(),
      width: z.number(),
      height: z.number(),
      cells: z.array(z.number()),
      ascii: z.string(),
      effectTiles: z.number(),
      effectOnCaster: z.boolean(),
    }).nullable(),
  })),
  maxDamage: z.record(z.string(), z.number().nullable()).nullable(),
  sounds: z.array(z.string()),
  detail, source: sourceSchema,
});
const itemOut = z.object({
  type: z.literal('item'),
  image: imageSchema,
  title: z.string(),
  itemClass: z.string().nullable(),
  itemType: z.string().nullable(),
  typeSecondary: z.string().nullable(),
  weight: z.number().nullable(),
  valueBuy: z.number().nullable(),
  valueSell: z.number().nullable(),
  isMarketable: z.boolean().nullable(),
  clientId: z.number().nullable(),
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
  boughtBy: z.array(z.object({ npc: z.string(), price: z.number(), currency: z.string() })),
  sounds: z.array(z.string()),
  detail, source: sourceSchema,
});
const npcOut = z.object({
  type: z.literal('npc'),
  image: imageSchema,
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
  buys: tradeSchema.describe('Items the player can sell to this NPC.'),
  sells: tradeSchema.describe('Items the player can buy from this NPC.'),
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
/** Derived from the wiki's animations, not from its tile data. Different from `area`. */
const spellShapeSchema = z.object({
  width: z.number(),
  height: z.number(),
  cells: z.array(z.number()),
  ascii: z.string(),
  affectedTiles: z.number(),
  derivedFrom: z.literal('animation'),
  sourceImage: z.string(),
  sourceUrl: z.string(),
  corroborated: z.boolean(),
}).nullable().describe('Tiles a spell covers, read from its wiki animation.');

const spellOut = z.object({
  type: z.literal('spell'),
  areaShape: spellShapeSchema,
  image: imageSchema,
  title: z.string(),
  words: z.string().nullable(),
  spellType: z.string().nullable(),
  element: z.string().nullable(),
  mana: z.number().nullable(),
  level: z.number().nullable(),
  soul: z.number().nullable(),
  isPremium: z.boolean().nullable(),
  cooldown: z.number().nullable(),
  effect: z.string().nullable(),
  vocations: z.array(z.enum(SPELL_VOCATIONS)),
  isPromotion: z.boolean().nullable(),
  isWheelSpell: z.boolean().nullable(),
  isPassive: z.boolean().nullable(),
  basePower: z.number().nullable(),
  group: z.string().nullable(),
  secondaryGroup: z.string().nullable(),
  runeGroup: z.string().nullable(),
  groupCooldown: z.number().nullable()
    .describe('Seconds before another spell of the same group can be cast.'),
  secondaryGroupCooldown: z.number().nullable()
    .describe('Seconds before another spell of its secondary group can be cast.'),
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
  image: imageSchema,
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
  image: imageSchema,
  title: z.string(),
  charmType: z.string().nullable(),
  effect: z.string().nullable(),
  costs: z.array(z.number().nullable()),
  status: z.string().nullable(),
  detail, source: sourceSchema,
});
const mountOut = z.object({
  type: z.literal('mount'),
  image: imageSchema,
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
  // Left-joined in one statement rather than a lookup per ability. The stored
  // columns are NOT NULL and already hold the matched row's identity, so only the
  // upstream side needs normalising: creature_ability.effect is NULL on 126 rows and
  // '' on 137 with the same meaning, and `=` matches neither while `is` matches only
  // the first. coalesce is the one form correct for both.
  const abilities = db.prepare(
    `select a.name, a.effect, a.element,
            p.key as area_key, p.width as area_width, p.cells as area_cells,
            m.effect_on_caster as area_on_caster
       from creature_ability a
       left join mcp_ability_area m
              on m.creature_id     = a.creature_id
             and m.ability_name    = a.name
             and m.ability_effect  = coalesce(a.effect, '')
             and m.ability_element = coalesce(a.element, '')
       left join mcp_area_pattern p on p.key = m.pattern_key
      where a.creature_id = ?
      order by a.name asc, a.effect asc, a.element asc`);
  // A separate statement rather than a join, matching how every other one-row child
  // is fetched here. Joining would also collide on article_id: `select *` at the
  // entity lookup is load-bearing (withDetail reads row[f], modifiers read
  // row['modifier_' + e]), and on a LEFT JOIN miss the later duplicate wins, so
  // row.article_id becomes NULL and every child query silently returns nothing.
  // A separate statement, like every other one-row child here. Spell shapes are
  // DERIVED from animations; creature abilities' `area` is the wiki's own tile data.
  // They are deliberately different fields with different types.
  const spellShapeRow = db.prepare(
    `select width, height, cells, source_image, source_url, corroborated
       from mcp_spell_area where article_id = ?`);
  const imageRow = db.prepare(
    `select file_name, url, description_url, width, height, mime_type
       from mcp_image where entity_type = ? and article_id = ?`);
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
  const questRewards = db.prepare(QUEST_REWARDS);
  const materials = db.prepare(
    `select i.title, m.amount from imbuement_material m join item i on i.article_id = m.item_id
     where m.imbuement_id = ? order by i.title asc`);
  // npc_offer_buy is the NPC buying FROM the player (where to sell an item), and
  // npc_offer_sell the NPC selling TO the player. Both tables hold exact duplicate
  // rows (Satsu's Cocktail Glass is there nine times), hence `distinct`.
  // currency_id is NOT NULL and names the currency item, e.g. Gold Coin.
  const boughtBy = (includeInactive: boolean) => {
    const status = statusClause('n', includeInactive);
    return db.prepare(
      `select distinct n.title as npc, o.value as price, cur.title as currency
         from npc_offer_buy o
         join npc n on n.article_id = o.npc_id
         join item cur on cur.article_id = o.currency_id
        where o.item_id = ?` + (status ? ` and ${status}` : '') + `
        order by o.value desc, n.title asc, cur.title asc`);
  };
  const npcTrade = (table: 'npc_offer_buy' | 'npc_offer_sell', includeInactive: boolean) => {
    const status = statusClause('i', includeInactive);
    return db.prepare(
      `select distinct i.title as item, o.value as price, cur.title as currency
         from ${table} o
         join item i on i.article_id = o.item_id
         join item cur on cur.article_id = o.currency_id
        where o.npc_id = ?` + (status ? ` and ${status}` : '') + `
        order by i.title asc, o.value asc, cur.title asc`);
  };
  const outfitQuests = db.prepare(
    // Total order: Assassin Outfits has two rows for the same quest title,
    // distinguished only by unlock_type ('outfit' and 'addons').
    `select q.title, oq.unlock_type from outfit_quest oq join quest q on q.article_id = oq.quest_id
     where oq.outfit_id = ? order by q.title asc, oq.unlock_type asc`);

  // tibiawiki-sql: "Day of the week, Monday starts at 0." Starting this array at
  // Sunday shifted the entire schedule by one day.
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  // The real columns of creature_max_damage. ELEMENTS includes 'healing', which
  // this table does NOT have — emitting it produced a phantom `healing: null`.
  const DAMAGE_KEYS = [
    'physical', 'earth', 'fire', 'ice', 'energy', 'death', 'holy', 'drown',
    'lifedrain', 'manadrain', 'summons', 'total',
  ] as const;
  // Upstream uses -1 for "damage is unknown", not for negative damage. Presented
  // as a number it reads as a measured value; 26 rows carry it.
  const damageValue = (v: unknown): number | null => {
    const n = num(v);
    return n === -1 ? null : n;
  };

  const trade = (o: Row) => ({
    item: String(o.item), price: Number(o.price), currency: String(o.currency),
  });

  const shape = (
    type: EntityType, row: Row, verbosity: 'concise' | 'detailed', includeInactive: boolean,
  ) => {
    const title = String(row.title);
    const spellShapeFor = (r: Row) => {
      const row = spellShapeRow.get(r.article_id as number) as Row | undefined;
      if (!row) return null;
      return renderSpellShape({
        width: Number(row.width), height: Number(row.height),
        cells: JSON.parse(String(row.cells)) as number[],
        sourceImage: String(row.source_image), sourceUrl: String(row.source_url),
        corroborated: Number(row.corroborated) === 1,
      });
    };
    const imageFor = (entityType: string, r: Row) => {
      const img = imageRow.get(entityType, r.article_id as number) as Row | undefined;
      return img
        ? {
            fileName: String(img.file_name),
            url: String(img.url), descriptionUrl: String(img.description_url),
            width: Number(img.width), height: Number(img.height), mimeType: String(img.mime_type),
          }
        : null;
    };
    const source = sourceBlock(title, provenance);
    const withDetail = <T extends object>(base: T, fields: readonly string[]): T =>
      verbosity === 'detailed'
        ? { ...base, detail: Object.fromEntries(fields.map((f) => [f, str(row[f])])) }
        : base;

    switch (type) {
      case 'creature':
        return withDetail({
          type: 'creature' as const, image: imageFor('creature', row), title,
          // 0 means unrecorded (see hitpointsExpr in domain.ts), so report null.
          hitpoints: row.hitpoints ? num(row.hitpoints) : null,
          experience: num(row.experience),
          armor: num(row.armor), speed: num(row.speed),
          bestiaryClass: str(row.bestiary_class), bestiaryLevel: str(row.bestiary_level),
          isBoss: Boolean(row.is_boss), status: str(row.status),
          runsAt: num(row.runs_at), seesInvisible: bool(row.sees_invisible),
          paralysable: bool(row.paralysable), pushable: bool(row.pushable),
          pushObjects: bool(row.push_objects), illusionable: bool(row.illusionable),
          summonCost: num(row.summon_cost), convinceCost: num(row.convince_cost),
          modifiers: Object.fromEntries(ELEMENTS.map((e) => [e, num(row[`modifier_${e}`])])),
          loot: drops.all(row.article_id as number).map((d) => ({
            item: String(d.item), chance: num(d.chance), min: num(d.lo), max: num(d.hi),
          })),
          abilities: abilities.all(row.article_id as number).map((a) => ({
            name: String(a.name), effect: str(a.effect), element: str(a.element),
            // null is the honest answer for an ability with no matched scene, and
            // most abilities have none. It must never be an empty grid.
            area: a.area_key === null || a.area_key === undefined ? null : renderArea(
              {
                key: String(a.area_key),
                width: Number(a.area_width),
                cells: JSON.parse(String(a.area_cells)) as number[],
              },
              { effectOnCaster: Number(a.area_on_caster) === 1 },
            ),
          })),
          maxDamage: (() => {
            const m = maxDamage.get(row.article_id as number) as Row | undefined;
            return m ? Object.fromEntries(DAMAGE_KEYS.map((k) => [k, damageValue(m[k])])) : null;
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
          type: 'item' as const, image: imageFor('item', row), title,
          itemClass: str(row.item_class), itemType: str(row.item_type),
          typeSecondary: str(row.type_secondary), weight: num(row.weight),
          valueBuy: num(row.value_buy), valueSell: num(row.value_sell),
          isMarketable: bool(row.is_marketable), clientId: num(row.client_id),
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
          boughtBy: boughtBy(includeInactive).all(row.article_id as number).map((o) => ({
            npc: String(o.npc), price: Number(o.price), currency: String(o.currency),
          })),
          sounds: itemSounds.all(row.article_id as number).map((r) => String(r.content)),
          source,
        }, DETAILED_ITEM_FIELDS);
      }
      case 'npc':
        return {
          type: 'npc' as const, image: imageFor('npc', row), title, gender: str(row.gender), city: str(row.city),
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
          buys: npcTrade('npc_offer_buy', includeInactive).all(row.article_id as number).map(trade),
          sells: npcTrade('npc_offer_sell', includeInactive).all(row.article_id as number).map(trade),
          source,
        };
      case 'quest':
        return {
          type: 'quest' as const, title, location: str(row.location),
          levelRequired: num(row.level_required), levelRecommended: num(row.level_recommended),
          isPremium: bool(row.is_premium),
          questLog: bool(row.quest_log), legend: str(row.legend),
          status: str(row.status),
          dangers: dangers.all(row.article_id as number).map((r) => String(r.title)),
          rewards: questRewards.all(row.article_id as number).map((r) => String(r.title)),
          source,
        };
      case 'spell':
        return {
          type: 'spell' as const, image: imageFor('spell', row), areaShape: spellShapeFor(row), title, words: str(row.words),
          spellType: str(row.spell_type), element: str(row.element),
          mana: num(row.mana), level: num(row.level), soul: num(row.soul),
          isPremium: bool(row.is_premium),
          cooldown: num(row.cooldown), effect: str(row.effect),
          vocations: SPELL_VOCATIONS.filter((v) => Number(row[v]) === 1),
          isPromotion: bool(row.is_promotion), isWheelSpell: bool(row.is_wheel_spell),
          isPassive: bool(row.is_passive), basePower: num(row.base_power),
          group: str(row.group_spell), secondaryGroup: str(row.group_secondary),
          runeGroup: str(row.group_rune), groupCooldown: num(row.cooldown_group),
          secondaryGroupCooldown: num(row.cooldown_group_secondary),
          status: str(row.status), source,
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
          type: 'imbuement' as const, image: imageFor('imbuement', row), title, tier: str(row.tier),
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
          type: 'charm' as const, image: imageFor('charm', row), title, charmType: str(row.type),
          effect: str(row.effect),
          costs: [num(row.cost_level_1), num(row.cost_level_2), num(row.cost_level_3)],
          status: str(row.status), source,
        };
      case 'mount':
        return {
          type: 'mount' as const, image: imageFor('mount', row), title, speed: num(row.speed),
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
        'abilities and max damage), item (with the NPCs that buy it), npc (with what it buys ' +
        'and sells), quest, spell, achievement, house, imbuement, ' +
        'charm, mount, outfit, book, world or update. Takes an exact page name — use ' +
        'tibia_search first if it is uncertain, or tibia_find_updates for an update page. ' +
        'Pass `type` to disambiguate a shared name. ' +
        `Creature abilities may carry an \`area\`: ${AREA_LEGEND}`,
      inputSchema: z.object({
        name: z.string().min(1).describe('Page name, e.g. "Dragon Lord". Case-insensitive.'),
        type: entityTypeSchema.optional().describe('Restrict the lookup to one kind of page.'),
        include_inactive: z.boolean().default(false)
          .describe('Include deprecated, event-only and unavailable pages. Applies to the requested ' +
            'page and to the NPCs or items in its trade lists.'),
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
      const output = shape(hit.type, hit.row, verbosity, include_inactive);
      const image = (output as {
        image?: { url: string; mimeType: string; fileName: string } | null;
      }).image ?? null;

      return {
        content: [
          { type: 'text', text: JSON.stringify(output) },
          // Annotated for the human: an animated sprite is not readable by a model
          // (only a first frame is ever seen), and rendering is host behaviour
          // rather than something this server can promise.
          ...(image
            ? [{
                type: 'resource_link' as const,
                uri: image.url,
                name: image.fileName,
                mimeType: image.mimeType,
                annotations: { audience: ['user' as const] },
              }]
            : []),
        ],
        structuredContent: output,
      };
    },
  );
}
