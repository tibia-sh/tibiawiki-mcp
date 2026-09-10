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
