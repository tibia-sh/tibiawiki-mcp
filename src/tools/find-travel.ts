import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { str, num, type TibiaDb } from '../db.ts';
import {
  TRAVEL_SORTS, fareSchema, originSchema, positionSchema, statusClause, travelSort,
} from '../domain.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

const outputSchema = z.object({
  results: z.array(z.object({
    npc: z.string(),
    city: z.string().nullable(),
    subarea: z.string().nullable(),
    location: z.string().nullable(),
    position: positionSchema,
    to: z.string(),
    origin: originSchema,
    price: fareSchema,
    notes: z.string().nullable(),
  })),
  totalMatches: z.number(),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export const NAME = 'tibia_find_travel';

export function registerFindTravel(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  server.registerTool(
    NAME,
    {
      description:
        'Find boat, carpet and other travel routes to or from a place, with fares. Each row ' +
        'is one leg with its start (origin) and the NPC\'s recorded city, location and ' +
        'position. Rows are single legs: this does not plan journeys.',
      // Strict so the old from_city is an error: dropped, {to, from_city} would return every
      // leg to that place.
      inputSchema: z.object({
        to: z.string().min(1).optional().describe('Exact destination, e.g. "Svargrond", any case.'),
        from: z.string().min(1).optional()
          .describe('Exact start place of the leg, e.g. "Meriana", any case.'),
        include_inactive: z.boolean().default(false),
        sort: z.enum(TRAVEL_SORTS).default('price')
          .describe('price ascends with 0 fares last, npc is alphabetical.'),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }).strict(),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      if (args.to === undefined && args.from === undefined) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Pass to, from or both.' }],
        };
      }

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
      const params: string[] = [];
      if (args.to !== undefined) {
        where.push('d.name = ? collate nocase');
        params.push(args.to);
      }
      if (args.from !== undefined) {
        where.push('d.origin = ? collate nocase');
        params.push(args.from);
      }
      const status = statusClause('n', args.include_inactive);
      if (status) where.push(status);

      const routes =
        `select distinct n.title, n.city, n.subarea, n.location, n.x, n.y, n.z,
                d.name, d.origin, d.price, d.notes
           from npc_destination d join npc n on n.article_id = d.npc_id
          where ${where.join(' and ')}`;
      const total = db.prepare(`select count(*) c from (${routes})`).get(...params) as
        { c: number };
      const rows = db
        .prepare(`${routes} order by ${travelSort(args.sort)} limit ? offset ?`)
        .all(...params, args.limit, offset);

      const output = {
        results: rows.map((row) => ({
          npc: String(row.title),
          city: str(row.city),
          subarea: str(row.subarea),
          location: str(row.location),
          position: { x: num(row.x), y: num(row.y), z: num(row.z) },
          to: String(row.name),
          origin: str(row.origin),
          price: num(row.price),
          notes: str(row.notes),
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
