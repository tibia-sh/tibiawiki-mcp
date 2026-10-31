import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from '../db.ts';
import {
  OFFER_DIRECTION_MEANING, OFFER_DIRECTIONS, OFFER_ORDER, offersQuery, type OfferDirection,
} from '../domain.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

const outputSchema = z.object({
  results: z.array(z.object({
    npc: z.string(),
    npcArticleId: z.number(),
    item: z.string(),
    itemArticleId: z.number(),
    price: z.number(),
    currency: z.string(),
    direction: z.enum(OFFER_DIRECTIONS).describe(OFFER_DIRECTION_MEANING),
  })),
  totalMatches: z.number(),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export const NAME = 'tibia_find_offers';

export function registerFindOffers(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  server.registerTool(
    NAME,
    {
      description:
        'Find NPC trade offers with prices by NPC, item, direction and currency, e.g. ' +
        '"everything Rashid buys" or "what costs Gold Tokens".',
      inputSchema: z.object({
        npc: z.string().min(1).optional().describe('Exact title, any case.'),
        item: z.string().min(1).optional().describe('Exact title, any case.'),
        direction: z.enum(OFFER_DIRECTIONS).optional().describe(OFFER_DIRECTION_MEANING),
        currency: z.string().min(1).optional().describe('e.g. "Gold Coin", any case.'),
        include_inactive: z.boolean().default(false).describe('Include inactive items.'),
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

      const { sql, params } = offersQuery(
        args.direction === undefined ? OFFER_DIRECTIONS : [args.direction],
        {
          npc: args.npc, item: args.item, currency: args.currency,
          includeInactive: args.include_inactive,
        },
      );
      const total = db.prepare(`select count(*) c from (${sql})`).get(...params) as { c: number };
      const rows = db
        .prepare(`select * from (${sql}) order by ${OFFER_ORDER} limit ? offset ?`)
        .all(...params, args.limit, offset);

      const output = {
        results: rows.map((row) => ({
          npc: String(row.npc),
          npcArticleId: Number(row.npc_article_id),
          item: String(row.item),
          itemArticleId: Number(row.item_article_id),
          price: Number(row.price),
          currency: String(row.currency),
          direction: row.direction as OfferDirection,
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
