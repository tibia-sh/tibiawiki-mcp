import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from '../db.ts';
import { HOUSE_SORTS, houseSort, statusClause } from '../domain.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

const outputSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    city: z.string(),
    street: z.string().nullable(),
    rent: z.number().nullable(),
    beds: z.number().nullable(),
    size: z.number().nullable(),
    rooms: z.number().nullable(),
    floors: z.number().nullable(),
    isGuildhall: z.boolean().nullable(),
  })),
  totalMatches: z.number(),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export const NAME = 'tibia_find_houses';

export function registerFindHouses(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  server.registerTool(
    NAME,
    {
      description:
        'Find Tibia houses and guildhalls by city, rent, beds and size. Use this for questions ' +
        'like "cheapest house in Thais with two beds". Call tibia_get with a title for its ' +
        'location and position.',
      inputSchema: z.object({
        city: z.string().min(1).optional().describe('Exact city name, e.g. "Thais", any case.'),
        rent_max: z.number().int().nonnegative().optional().describe('Highest monthly rent in gold.'),
        beds_min: z.number().int().nonnegative().optional(),
        size_min: z.number().int().nonnegative().optional().describe('Fewest tiles.'),
        is_guildhall: z.boolean().optional(),
        include_inactive: z.boolean().default(false),
        sort: z.enum(HOUSE_SORTS).default('rent')
          .describe('rent ascends, size descends, title is alphabetical.'),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      let offset: number;
      try {
        offset = decodeCursor(args.cursor);
      } catch {
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid cursor: ${args.cursor}. Omit it to start over.` }],
        };
      }

      const where: string[] = [];
      const params: Array<string | number> = [];
      const bind = (clause: string, value: string | number) => {
        where.push(clause);
        params.push(value);
      };
      if (args.city !== undefined) bind('h.city = ? collate nocase', args.city);
      if (args.rent_max !== undefined) bind('h.rent <= ?', args.rent_max);
      if (args.beds_min !== undefined) bind('h.beds >= ?', args.beds_min);
      if (args.size_min !== undefined) bind('h.size >= ?', args.size_min);
      if (args.is_guildhall !== undefined) bind('h.is_guildhall = ?', args.is_guildhall ? 1 : 0);
      const status = statusClause('h', args.include_inactive);
      if (status) where.push(status);

      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const total = db.prepare(`select count(*) c from house h ${clause}`).get(...params) as
        { c: number };
      const rows = db
        .prepare(`select h.* from house h ${clause} order by ${houseSort(args.sort)} limit ? offset ?`)
        .all(...params, args.limit, offset);

      const num = (v: unknown): number | null => (v === null ? null : Number(v));
      const output = {
        results: rows.map((row) => ({
          title: String(row.title),
          city: String(row.city),
          street: row.street === null ? null : String(row.street),
          rent: num(row.rent),
          beds: num(row.beds),
          size: num(row.size),
          rooms: num(row.rooms),
          floors: num(row.floors),
          isGuildhall: row.is_guildhall === null ? null : Boolean(row.is_guildhall),
        })),
        totalMatches: total.c,
        ...(offset + args.limit < total.c ? { nextCursor: encodeCursor(offset + args.limit) } : {}),
        indexGeneratedAt: provenance.generatedAt,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
