import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ELEMENTS } from './domain.ts';

export type Provenance = { version: string; generatedAt: string };
export type TibiaDb = { db: DatabaseSync; provenance: Provenance; close(): void };

/** Thrown when the index opens but does not have the shape every tool assumes. */
export class SchemaError extends Error {}

/**
 * The shape the tools require. Probed once at startup so a generator-version drift
 * names the column it is missing instead of silently returning nulls for it.
 */
const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  creature: [
    'article_id', 'title', 'name', 'hitpoints', 'experience', 'armor', 'speed',
    'bestiary_class', 'bestiary_occurrence', 'is_boss', 'location', 'spawn_type',
    'mitigation', 'walks_through', 'walks_around', 'status',
    ...ELEMENTS.map((e) => `modifier_${e}`),
  ],
  item: [
    'article_id', 'title', 'item_class', 'item_type', 'type_secondary', 'weight',
    'value_buy', 'value_sell', 'is_marketable', 'flavor_text', 'status',
  ],
  item_attribute: ['item_id', 'name', 'value'],
  creature_drop: ['creature_id', 'item_id', 'chance', 'min', 'max'],
  npc: ['article_id', 'title', 'gender', 'city', 'subarea', 'location', 'x', 'y', 'z', 'status'],
  npc_offer_sell: ['npc_id', 'item_id', 'value', 'currency_id'],
  npc_offer_buy: ['npc_id', 'item_id', 'value', 'currency_id'],
  quest: [
    'article_id', 'title', 'location', 'level_required', 'level_recommended',
    'is_premium', 'quest_log', 'legend', 'status',
  ],
  quest_reward: ['quest_id', 'item_id'],
  spell: [
    'article_id', 'title', 'words', 'spell_type', 'element', 'mana', 'level',
    'soul', 'is_premium', 'cooldown', 'status',
  ],
  // Entity tables added when ENTITY_TYPES grew from 5 to 14.
  achievement: ['article_id', 'title', 'grade', 'points', 'description', 'spoiler', 'is_secret', 'is_premium', 'achievement_id', 'status'],
  house: ['article_id', 'title', 'house_id', 'city', 'street', 'location', 'rent', 'size', 'beds', 'rooms', 'floors', 'x', 'y', 'z', 'is_guildhall', 'status'],
  imbuement: ['article_id', 'title', 'tier', 'category', 'type', 'effect', 'slots', 'status'],
  charm: ['article_id', 'title', 'type', 'effect', 'cost_level_1', 'cost_level_2', 'cost_level_3', 'status'],
  mount: ['article_id', 'title', 'speed', 'taming_method', 'is_buyable', 'price', 'achievement', 'light_color', 'light_radius', 'status'],
  outfit: ['article_id', 'title', 'outfit_type', 'is_premium', 'is_bought', 'is_tournament', 'full_price', 'achievement', 'status'],
  book: ['article_id', 'title', 'book_type', 'item_id', 'location', 'blurb', 'author', 'prev_book', 'next_book', 'text', 'status'],
  world: ['article_id', 'title', 'location', 'pvp_type', 'is_preview', 'is_experimental', 'online_since', 'offline_since', 'merged_into', 'battleye', 'battleye_type', 'protected_since', 'world_board', 'trade_board'],
  game_update: ['article_id', 'title', 'release_date', 'news_id', 'type_primary', 'type_secondary', 'previous', 'next', 'summary', 'changes'],
  // Child tables the detail sections read.
  creature_ability: ['creature_id', 'name', 'effect', 'element'],
  creature_max_damage: ['creature_id', 'physical', 'earth', 'fire', 'ice', 'energy', 'death', 'holy', 'drown', 'lifedrain', 'manadrain', 'summons', 'total'],
  creature_sound: ['creature_id', 'content'],
  item_key: ['item_id', 'title', 'number', 'name', 'material', 'location', 'notes'],
  item_sound: ['item_id', 'content'],
  item_store_offer: ['item_id', 'price', 'amount', 'currency'],
  item_proficiency_perk: ['item_id', 'proficiency_level', 'effect', 'skill_image'],
  npc_job: ['npc_id', 'name'],
  npc_race: ['npc_id', 'name'],
  npc_destination: ['npc_id', 'name', 'price', 'notes'],
  quest_danger: ['quest_id', 'creature_id'],
  imbuement_material: ['imbuement_id', 'item_id', 'amount'],
  outfit_quest: ['outfit_id', 'quest_id', 'unlock_type'],
  rashid_position: ['day', 'city', 'location', 'x', 'y', 'z'],
  database_info: ['key', 'value'],
};

/** database_info is key/value, so it is validated by row key, not by column. */
const REQUIRED_INFO_KEYS = ['version', 'generate_time'] as const;

export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TIBIAWIKI_MCP_DB;
  if (override) return override;
  const cache = env.XDG_CACHE_HOME ?? join(env.HOME ?? '', '.cache');
  return join(cache, 'tibiawiki-mcp', 'tibiawiki.db');
}

export function openDb(path: string = resolveDbPath()): TibiaDb {
  if (!existsSync(path)) {
    throw new Error(
      `TibiaWiki index not found at ${path}. Run \`tibiawiki-mcp build-index\` to create it.`,
    );
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assertSchema(db);
    const provenance = readProvenance(db);
    return { db, provenance, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

function assertSchema(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = new Set(
      db.prepare(`pragma table_info("${table}")`).all().map((r) => String(r.name)),
    );
    if (present.size === 0) {
      throw new SchemaError(
        `Index is missing required table "${table}". Rebuild it with \`tibiawiki-mcp build-index\`.`,
      );
    }
    const missing = columns.filter((c) => !present.has(c));
    if (missing.length > 0) {
      throw new SchemaError(
        `Index table "${table}" is missing required column(s): ${missing.join(', ')}. ` +
          'The index was likely built by a different tibiawiki-sql version; rebuild with ' +
          '`tibiawiki-mcp build-index`.',
      );
    }
  }
  const keys = new Set(
    db.prepare('select key from database_info').all().map((r) => String(r.key)),
  );
  const missingKeys = REQUIRED_INFO_KEYS.filter((k) => !keys.has(k));
  if (missingKeys.length > 0) {
    throw new SchemaError(
      `Index table "database_info" is missing required key(s): ${missingKeys.join(', ')}. ` +
        'Rebuild with `tibiawiki-mcp build-index`.',
    );
  }
}

function readProvenance(db: DatabaseSync): Provenance {
  const rows = db.prepare('select key, value from database_info').all();
  const map = new Map(rows.map((r) => [String(r.key), String(r.value)]));
  return {
    version: map.get('version') ?? 'unknown',
    generatedAt: map.get('generate_time') ?? 'unknown',
  };
}
