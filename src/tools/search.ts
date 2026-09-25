import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from '../db.ts';
import {
  ENTITY_TYPES, entityTypeSchema, entityTable, entityHasStatus, statusClause, asciiLower,
  likePattern, type EntityType,
} from '../domain.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

const outputSchema = z.object({
  results: z.array(z.object({ title: z.string(), type: z.string() })),
  totalMatches: z.number(),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export const NAME = 'tibia_search';

export function registerSearch(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  // One prepared statement per (type, status) pair. Table names come from the
  // closed map in domain.ts and are never interpolated from user input. A null
  // pattern lists every page of the type. Patterns come from likePattern, so %, _ and
  // a backslash in a query match themselves.
  const statements = new Map<string, ReturnType<typeof db.prepare>>();
  for (const type of ENTITY_TYPES) {
    for (const includeInactive of [false, true]) {
      // world and game_update have no status column, so the clause must be omitted
      // entirely rather than merely disabled - these statements are prepared eagerly
      // here, so an unconditional clause would fail at server construction.
      const status = entityHasStatus(type) ? statusClause('t', includeInactive) : '';
      // An item also matches by the name and plural the game prints, one row per item.
      const inGame = type === 'item'
        ? " or t.actual_name like ?1 collate nocase escape '\\'" +
          " or t.plural like ?1 collate nocase escape '\\'"
        : '';
      statements.set(
        `${type}:${includeInactive}`,
        db.prepare(
          `select t.title from "${entityTable(type)}" t
           where (?1 is null or t.title like ?1 collate nocase escape '\\'${inGame})` +
            (status ? ` and ${status}` : ''),
        ),
      );
    }
  }

  server.registerTool(
    NAME,
    {
      description:
        'Find Tibia pages whose name contains a substring, across all fourteen kinds of ' +
        'page (creature, item, npc, quest, spell, achievement, house, imbuement, charm, ' +
        'mount, outfit, book, world, update). Items also match by the name and plural the game ' +
        'prints. Turns an approximate or in-game name into the exact page name tibia_get expects. ' +
        'With a query, ordered shortest name first, so the closest ' +
        'match leads. With types and no query, lists every page of those types by title, ' +
        'as in "list every mount".',
      inputSchema: z.object({
        query: z.string().min(1).optional()
          .describe('Substring to match against page names, case-insensitive. Omit it to list every page of types.'),
        types: z.array(entityTypeSchema).optional()
          .describe('Restrict to these kinds of page. Defaults to all fourteen. Required without a query.'),
        include_inactive: z.boolean().default(false)
          .describe('Include deprecated, event-only and unavailable pages.'),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional().describe('Opaque cursor from a previous call.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, types, include_inactive, limit, cursor }) => {
      if (query === undefined && !types?.length) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: 'Pass a query with a name fragment, or types to list every page of those types.',
          }],
        };
      }

      let offset: number;
      try {
        offset = decodeCursor(cursor);
      } catch {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Invalid cursor: ${cursor}. Pass only a nextCursor returned by a previous ` +
              'tibia_search call, or omit it to start from the beginning.',
          }],
        };
      }

      const wanted: readonly EntityType[] = types ? [...new Set(types)] : ENTITY_TYPES;
      const pattern = query === undefined ? null : likePattern(query);
      const all: Array<{ title: string; type: EntityType }> = [];
      for (const type of wanted) {
        const stmt = statements.get(`${type}:${include_inactive}`)!;
        for (const row of stmt.all(pattern)) {
          all.push({ title: String(row.title), type });
        }
      }
      if (query === undefined) {
        // By title as the nocase collation orders it, then type and the exact title,
        // so the merge across tables is a total order and pages stay stable.
        const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
        all.sort(
          (a, b) =>
            byCode(asciiLower(a.title), asciiLower(b.title)) ||
            byCode(a.type, b.type) ||
            byCode(a.title, b.title),
        );
      } else {
        // Total order: shortest first, then alphabetical, then type as the final
        // tiebreak so cross-table pagination is stable between calls.
        all.sort(
          (a, b) =>
            a.title.length - b.title.length ||
            a.title.localeCompare(b.title) ||
            a.type.localeCompare(b.type),
        );
      }

      const page = all.slice(offset, offset + limit);
      const output = {
        results: page,
        totalMatches: all.length,
        ...(offset + limit < all.length ? { nextCursor: encodeCursor(offset + limit) } : {}),
        indexGeneratedAt: provenance.generatedAt,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
