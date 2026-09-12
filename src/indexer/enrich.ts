import { DatabaseSync } from 'node:sqlite';
import { parseSceneData } from './scene-data.ts';
import { extractSceneRefs, type AbilityRow, type ExtractStats } from './ability-scenes.ts';
import { resolveImages, type Subject, type TypeStats } from './images.ts';
import type { EntityType } from '../domain.ts';
import type { WikiApi } from './wiki-api.ts';

/**
 * Build-time enrichment: writes the ability area grids the generator never produces.
 *
 * Runs on the generator's temp output, before validation and before the atomic
 * rename, so a failure here leaves any pre-existing index untouched. It opens its
 * own writable handle - `openDb` is read-only and schema-validating, and once the
 * probe requires these tables it would reject the generator's own fresh output.
 */

const SCENE_DATA_PAGE = 'Module:SceneBuilder/data';
const CREATURE_CATEGORY = 'Category:Creatures';

/** Bumped only when the shape below changes, so a stale index fails loudly. */
export const MCP_SCHEMA_VERSION = 2;

/**
 * The tables carrying an entity image. Every row is a subject, including
 * `deprecated` and `ts-only` ones: that is the denominator the measured per-type
 * resolution rates and the build's floor are calibrated on.
 */
export const IMAGE_TYPES: ReadonlyArray<{ entityType: EntityType; table: string }> = [
  { entityType: 'creature', table: 'creature' },
  { entityType: 'item', table: 'item' },
  { entityType: 'npc', table: 'npc' },
  { entityType: 'spell', table: 'spell' },
  { entityType: 'mount', table: 'mount' },
  { entityType: 'imbuement', table: 'imbuement' },
  { entityType: 'charm', table: 'charm' },
];

export type EnrichStats = ExtractStats & {
  patterns: number;
  rejectedPatterns: Array<{ key: string; reason: string }>;
  stored: number;
  images: Partial<Record<EntityType, TypeStats>>;
  danglingKey: number;
  pagesNotInIndex: number;
  /** Indexed creature pages the API listed but returned no content for. */
  missingPages: number;
  /** Two members resolving to one ability row but naming different patterns. */
  conflictingKey: number;
};

export type Enricher = (dbPath: string, api: WikiApi) => Promise<EnrichStats>;

const DDL = `
drop table if exists mcp_ability_area;
drop table if exists mcp_area_pattern;
drop table if exists mcp_schema_version;
drop table if exists mcp_image;

create table mcp_area_pattern (
  key   text    primary key,
  width integer not null,
  cells text    not null
);

create table mcp_ability_area (
  creature_id      integer not null,
  ability_name     text    not null,
  ability_effect   text    not null default '',
  ability_element  text    not null default '',
  pattern_key      text    not null references mcp_area_pattern(key),
  effect_on_caster integer not null,
  primary key (creature_id, ability_name, ability_effect, ability_element)
);

create table mcp_schema_version (version integer not null);

create table mcp_image (
  entity_type     text    not null,
  article_id      integer not null,
  file_name       text    not null,
  url             text    not null,
  description_url text    not null,
  width           integer not null,
  height          integer not null,
  mime_type       text    not null,
  primary key (entity_type, article_id)
);
`;

export async function enrich(dbPath: string, api: WikiApi): Promise<EnrichStats> {
  const lua = await api.moduleSource(SCENE_DATA_PAGE);
  const { patterns, rejected } = parseSceneData(lua);
  const known = new Set(patterns.map((p) => p.key));

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('pragma foreign_keys = ON');
    // Dropped and recreated rather than emptied, so no stale row can survive a
    // rebuild whose source no longer produces it.
    db.exec(DDL);

    const insertPattern = db.prepare('insert into mcp_area_pattern (key, width, cells) values (?, ?, ?)');
    for (const p of patterns) insertPattern.run(p.key, p.width, JSON.stringify(p.cells));

    const rows = new Map<number, AbilityRow[]>();
    for (const r of db.prepare('select creature_id, name, effect, element from creature_ability').all()) {
      const id = Number(r['creature_id']);
      const list = rows.get(id) ?? [];
      list.push({
        name: String(r['name']),
        effect: r['effect'] === null ? null : String(r['effect']),
        element: r['element'] === null ? null : String(r['element']),
      });
      rows.set(id, list);
    }
    const ids = new Map<string, number>();
    for (const r of db.prepare('select article_id, title from creature').all()) {
      ids.set(String(r['title']), Number(r['article_id']));
    }

    const stats: EnrichStats = {
      scenes: 0, joined: 0, ambiguous: 0, noRow: 0,
      discardedKind: 0, discardedNoSpell: 0, discardedRotate: 0, unparsedMember: 0,
      patterns: patterns.length, rejectedPatterns: rejected,
      stored: 0, images: {}, danglingKey: 0, pagesNotInIndex: 0, missingPages: 0, conflictingKey: 0,
    };

    const insertArea = db.prepare(
      `insert into mcp_ability_area
         (creature_id, ability_name, ability_effect, ability_element, pattern_key, effect_on_caster)
       values (?, ?, ?, ?, ?, ?)`,
    );
    // `insert or ignore` would let a second member silently lose to the first while
    // still counting as stored, making the outcome depend on member order. Track the
    // identities instead, so a genuine conflict is visible rather than arbitrary.
    const placed = new Map<string, string>();

    // The category holds list pages and redirects as well as creatures; those are
    // skipped and never charged against the coverage gate.
    const titles = await api.categoryMembers(CREATURE_CATEGORY);
    for (let i = 0; i < titles.length; i += 50) {
      const batch = titles.slice(i, i + 50);
      const pages = await api.pageWikitext(batch);
      // A page the API lists but does not return content for would otherwise vanish
      // from both numerator and denominator, so a truncated response could report
      // full coverage while the index silently lost every area on those pages.
      const returned = new Set(pages.map((p) => p.title));
      for (const title of batch) {
        if (!returned.has(title) && ids.has(title)) stats.missingPages += 1;
      }
      for (const page of pages) {
        const creatureId = ids.get(page.title);
        if (creatureId === undefined) {
          stats.pagesNotInIndex += 1;
          continue;
        }
        const { refs, stats: pageStats } = extractSceneRefs(page.wikitext, rows.get(creatureId) ?? []);
        for (const key of Object.keys(pageStats) as Array<keyof ExtractStats>) {
          stats[key] += pageStats[key];
        }
        for (const ref of refs) {
          // A reference to a pattern the module does not define is counted and
          // dropped; the foreign key is the backstop, not the check.
          if (!known.has(ref.patternKey)) {
            stats.danglingKey += 1;
            continue;
          }
          const identity = [creatureId, ref.abilityName, ref.abilityEffect, ref.abilityElement].join('\u0000');
          const existing = placed.get(identity);
          if (existing !== undefined) {
            if (existing !== ref.patternKey) stats.conflictingKey += 1;
            continue;
          }
          placed.set(identity, ref.patternKey);
          insertArea.run(
            creatureId,
            ref.abilityName,
            ref.abilityEffect,
            ref.abilityElement,
            ref.patternKey,
            ref.effectOnCaster ? 1 : 0,
          );
          stats.stored += 1;
        }
      }
    }

    // Images: a URL and its pixel size, never the bytes.
    const subjects: Subject[] = [];
    for (const { entityType, table } of IMAGE_TYPES) {
      for (const r of db.prepare(`select article_id, title from "${table}"`).all()) {
        subjects.push({ entityType, articleId: Number(r['article_id']), title: String(r['title']) });
      }
    }
    const { refs, stats: imageStats } = await resolveImages(subjects, api);
    stats.images = imageStats;

    const insertImage = db.prepare(
      `insert into mcp_image
         (entity_type, article_id, file_name, url, description_url, width, height, mime_type)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const ref of refs) {
      insertImage.run(
        ref.entityType, ref.articleId, ref.fileName,
        ref.url, ref.descriptionUrl, ref.width, ref.height, ref.mimeType,
      );
    }

    // Measured on disk, not from intent. resolveImages reports what it MEANT to
    // store; without this the per-type floor passes over an index whose mcp_image
    // is empty, and every tibia_get then returns image: null with nothing failing.
    const writtenImages = Number(
      (db.prepare('select count(*) c from mcp_image').get() as { c: number }).c,
    );
    if (writtenImages !== refs.length) {
      throw new Error(
        `Image rows on disk (${writtenImages}) do not match the ${refs.length} resolved. ` +
          'Enrichment did not store what it resolved; refusing to install.',
      );
    }

    db.prepare('insert into mcp_schema_version (version) values (?)').run(MCP_SCHEMA_VERSION);
    return stats;
  } finally {
    db.close();
  }
}

/**
 * Scenes that should have produced an area. Intentional discards are excluded, so
 * the ratio measures what was actually lost rather than what was correctly dropped.
 */
export function eligibleScenes(stats: EnrichStats): number {
  return stats.scenes
    - stats.discardedKind
    - stats.discardedNoSpell
    - stats.discardedRotate
    - stats.unparsedMember;
}

export function formatStats(stats: EnrichStats): string {
  const eligible = eligibleScenes(stats);
  const pct = eligible > 0 ? ((100 * stats.stored) / eligible).toFixed(1) : 'n/a';
  return [
    `  patterns        ${stats.patterns}${stats.rejectedPatterns.length > 0 ? ` (${stats.rejectedPatterns.length} rejected)` : ''}`,
    `  scenes          ${stats.scenes}`,
    `    stored        ${stats.stored}`,
    `    ambiguous     ${stats.ambiguous}`,
    `    no row        ${stats.noRow}`,
    `    dangling key  ${stats.danglingKey}`,
    `    discarded     ${stats.discardedKind} kind, ${stats.discardedNoSpell} no-spell, ${stats.discardedRotate} rotate90, ${stats.unparsedMember} unparsed`,
    `    conflicting   ${stats.conflictingKey}`,
    `  pages not in index ${stats.pagesNotInIndex}`,
    `  MISSING pages      ${stats.missingPages}`,
    `  stored/eligible ${stats.stored}/${eligible} = ${pct}%`,
    '  images:',
    ...IMAGE_TYPES.map(({ entityType }) => {
      const s = stats.images[entityType];
      if (!s) return `    ${entityType.padEnd(10)} NO SUBJECTS`;
      const rate = s.subjects > 0 ? ((100 * s.resolved) / s.subjects).toFixed(1) : 'n/a';
      return `    ${entityType.padEnd(10)} ${s.resolved}/${s.subjects} = ${rate}%` +
        `  (missing ${s.missing}, invalid ${s.invalid}, skipped ${s.skipped})`;
    }),
  ].join('\n');
}
