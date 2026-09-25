import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { str, num, type TibiaDb } from '../db.ts';
import {
  asciiLower, BEST_GOLD_PRICE, buyerCitySchema, buyerPlace, buyerPositionSchema, RASHID,
  RASHID_SCHEDULE, rashidScheduleSchema, rashidScheduleDay, resolveItemName,
} from '../domain.ts';

const buyerSchema = z.object({
  npc: z.string(),
  position: buyerPositionSchema,
  rashidSchedule: rashidScheduleSchema.optional(),
  items: z.array(z.object({
    item: z.string(),
    input: z.string().describe('The name as you first wrote it.'),
    price: z.number(),
  })),
});
type Buyer = z.infer<typeof buyerSchema>;

const outputSchema = z.object({
  cities: z.array(z.object({
    city: buyerCitySchema,
    buyers: z.array(buyerSchema),
  })),
  noGoldBuyer: z.array(z.string()).describe('Items no active NPC buys for gold.'),
  unknownItems: z.array(z.string()).describe('Names that match no item.'),
  ambiguousItems: z.array(z.object({ input: z.string(), candidates: z.array(z.string()) }))
    .describe('Names more than one item goes by, with those items.'),
  indexGeneratedAt: z.string(),
});

export const NAME = 'tibia_where_to_sell';

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Cities by name as the nocase collation orders them, then exactly, with null last. */
const cityOrder = (a: string | null, b: string | null): number =>
  a === null ? (b === null ? 0 : 1)
  : b === null ? -1
  : byName(asciiLower(a), asciiLower(b)) || byName(a, b);

export function registerWhereToSell(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;
  // BEST_GOLD_PRICE ranks every offer, so it runs once for the whole list.
  const bestBuyers = db.prepare(
    `select i.article_id, i.title as item, best.price, n.title as npc, n.city, n.x, n.y, n.z
       from item i
       left join (${BEST_GOLD_PRICE}) best on best.item_id = i.article_id
       left join npc n on n.article_id = best.npc_id
      where i.article_id in (select value from json_each(?))
      order by n.title asc, i.title asc`);
  const rashid = db.prepare(RASHID_SCHEDULE);

  server.registerTool(
    NAME,
    {
      description:
        'Answers "where do I sell all this": for each item, the active NPC paying the most, ' +
        'grouped by city and NPC. Prices are NPC prices in gold. Call tibia_get on an NPC ' +
        'for more.',
      inputSchema: z.object({
        items: z.array(z.string().min(1)).min(1).max(100)
          .describe('Item names, any case, as the wiki titles them or the game prints them, ' +
            'e.g. "Dragon Shield" or "vial of lifefluid".'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ items }) => {
      // Each name once by its fold, as the caller first wrote it.
      const names = new Map<string, string>();
      for (const name of items) if (!names.has(asciiLower(name))) names.set(asciiLower(name), name);

      // Each item once, under the first name that resolves to it.
      const inputs = new Map<number, string>();
      const unknownItems: string[] = [];
      const ambiguousItems: Array<{ input: string; candidates: string[] }> = [];
      for (const name of names.values()) {
        const found = resolveItemName(db, name);
        if (found.length === 1) {
          if (!inputs.has(found[0]!.articleId)) inputs.set(found[0]!.articleId, name);
        } else if (found.length > 1) {
          ambiguousItems.push({ input: name, candidates: found.map((i) => i.title) });
        } else {
          unknownItems.push(name);
        }
      }

      const noGoldBuyer: string[] = [];
      const cities = new Map<string | null, Buyer[]>();
      let buyer: Buyer | undefined;
      for (const row of bestBuyers.all(JSON.stringify([...inputs.keys()]))) {
        const item = String(row.item);
        if (row.npc === null) {
          noGoldBuyer.push(item);
          continue;
        }
        const npc = String(row.npc);
        if (buyer?.npc !== npc) {
          const place = buyerPlace(npc, str(row.city), { x: num(row.x), y: num(row.y), z: num(row.z) });
          buyer = {
            npc, position: place.position,
            ...(npc === RASHID ? { rashidSchedule: rashid.all().map(rashidScheduleDay) } : {}),
            items: [],
          };
          const inCity = cities.get(place.city);
          if (inCity) inCity.push(buyer);
          else cities.set(place.city, [buyer]);
        }
        buyer.items.push({ item, input: inputs.get(Number(row.article_id))!, price: Number(row.price) });
      }

      const output = {
        cities: [...cities].sort(([a], [b]) => cityOrder(a, b)).map(([city, buyers]) => ({ city, buyers })),
        noGoldBuyer,
        unknownItems,
        ambiguousItems,
        indexGeneratedAt: provenance.generatedAt,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
