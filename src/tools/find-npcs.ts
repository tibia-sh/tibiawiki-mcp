import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { str, num, type TibiaDb } from '../db.ts';
import {
  NPC_JOBS, NPC_SORTS, RASHID, buyerCitySchema, buyerPlace, buyerPositionSchema, npcSort,
  offersQuery, statusClause, type OfferDirection,
} from '../domain.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

const outputSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    articleId: z.number(),
    city: buyerCitySchema,
    jobs: z.array(z.string()),
    position: buyerPositionSchema,
  })),
  totalMatches: z.number(),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export const NAME = 'tibia_find_npcs';

export function registerFindNpcs(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;
  const jobs = db.prepare(NPC_JOBS);

  server.registerTool(
    NAME,
    {
      description:
        'Find NPCs by city, job and the items they buy or sell, for questions like "who in ' +
        'Thais buys Dragon Shield". Call tibia_get on a title for its offers and travel.',
      inputSchema: z.object({
        city: z.string().min(1).optional().describe('Exact city name, e.g. "Thais", any case.'),
        job: z.string().min(1).optional()
          .describe('Exact job, e.g. "Shopkeeper", any case. Matches any of an NPC\'s jobs.'),
        buys: z.string().min(1).optional()
          .describe('Exact item page name, any case: NPCs that buy it from the player.'),
        sells: z.string().min(1).optional()
          .describe('Exact item page name, any case: NPCs that sell it to the player.'),
        include_inactive: z.boolean().default(false)
          .describe('Include inactive NPCs, and inactive items for buys and sells.'),
        sort: z.enum(NPC_SORTS).default('title'),
        limit: z.number().int().min(1).max(100).default(100),
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
      const params: string[] = [];
      // The wiki records a city for Rashid, but he moves to another one every day, so his
      // rows report none and he matches no city.
      if (args.city !== undefined) {
        where.push('n.city = ? collate nocase and n.title <> ?');
        params.push(args.city, RASHID);
      }
      if (args.job !== undefined) {
        where.push(
          'exists (select 1 from npc_job j where j.npc_id = n.article_id and j.name = ? collate nocase)');
        params.push(args.job);
      }
      const trades = (direction: OfferDirection, item: string) => {
        const offers = offersQuery([direction], { item, includeInactive: args.include_inactive });
        where.push(`n.article_id in (select npc_article_id from (${offers.sql}))`);
        params.push(...offers.params);
      };
      if (args.buys !== undefined) trades('buy', args.buys);
      if (args.sells !== undefined) trades('sell', args.sells);
      const status = statusClause('n', args.include_inactive);
      if (status) where.push(status);

      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const total = db.prepare(`select count(*) c from npc n ${clause}`).get(...params) as
        { c: number };
      const rows = db
        .prepare(`select n.title, n.article_id, n.city, n.x, n.y, n.z from npc n ${clause}
                  order by ${npcSort(args.sort)} limit ? offset ?`)
        .all(...params, args.limit, offset);

      const output = {
        results: rows.map((row) => {
          const title = String(row.title);
          const place = buyerPlace(title, str(row.city), { x: num(row.x), y: num(row.y), z: num(row.z) });
          return {
            title,
            articleId: Number(row.article_id),
            city: place.city,
            jobs: jobs.all(row.article_id as number).map((j) => String(j.name)),
            position: place.position,
          };
        }),
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
