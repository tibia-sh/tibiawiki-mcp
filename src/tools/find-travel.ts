import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { str, num, type TibiaDb } from '../db.ts';
import { TRAVEL_SORTS, fareSchema, positionSchema, statusClause, travelSort } from '../domain.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

const outputSchema = z.object({
  results: z.array(z.object({
    npc: z.string(),
    city: z.string().nullable(),
    subarea: z.string().nullable(),
    location: z.string().nullable(),
    position: positionSchema,
    to: z.string(),
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
        'Find boat, carpet and other travel routes to a place or from a city, with fares. ' +
        'Each row gives the NPC\'s recorded city, location and position. The index records ' +
        'no separate start per route, and some NPCs work from more than one place, so read ' +
        'notes such as "From Meriana". Rows are single legs: this does not plan journeys.',
      inputSchema: z.object({
        to: z.string().min(1).optional().describe('Exact destination, e.g. "Svargrond", any case.'),
        from_city: z.string().min(1).optional().describe('Exact city of the NPC, any case.'),
        include_inactive: z.boolean().default(false),
        sort: z.enum(TRAVEL_SORTS).default('price')
          .describe('price ascends with 0 fares last, npc is alphabetical.'),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      if (args.to === undefined && args.from_city === undefined) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Pass to, from_city or both.' }],
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
      if (args.from_city !== undefined) {
        where.push('n.city = ? collate nocase');
        params.push(args.from_city);
      }
      const status = statusClause('n', args.include_inactive);
      if (status) where.push(status);

      const routes =
        `select distinct n.title, n.city, n.subarea, n.location, n.x, n.y, n.z,
                d.name, d.price, d.notes
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
