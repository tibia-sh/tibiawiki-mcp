import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from '../db.ts';
import { statusClause } from '../domain.ts';
import { sourceBlock } from './get.ts';

const outputSchema = z.object({
  item: z.string(),
  status: z.string().nullable(),
  droppedBy: z.array(z.object({
    creature: z.string(),
    chance: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
  })),
  soldByNpcs: z.array(z.object({
    npc: z.string(),
    city: z.string().nullable(),
    price: z.number(),
    currency: z.string(),
  })),
  questRewards: z.array(z.string()),
  note: z.string(),
  source: z.object({ page: z.string(), url: z.string(), indexGeneratedAt: z.string() }),
});

export const NAME = 'tibia_how_to_obtain';

export function registerHowToObtain(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  const findItem = db.prepare(
    'select article_id, title, status from item where title = ? collate nocase',
  );

  const dropped = (includeInactive: boolean) => {
    const status = statusClause('c', includeInactive);
    return db.prepare(
      `select c.title as creature, d.chance, d.min as lo, d.max as hi
       from creature_drop d join creature c on c.article_id = d.creature_id
       where d.item_id = ?` + (status ? ` and ${status}` : '') + `
       order by (d.chance is null), d.chance desc, c.title asc`,
    );
  };
  // npc_offer_sell is the NPC selling TO the player. This is the obtaining
  // direction; npc_offer_buy is the player selling to the NPC, at a lower price.
  // The table holds exact duplicate rows (Satsu's Cocktail Glass nine times), hence
  // `distinct`.
  const vendors = (includeInactive: boolean) => {
    const status = statusClause('n', includeInactive);
    return db.prepare(
      `select distinct n.title as npc, n.city, o.value as price,
              coalesce(cur.title, 'Gold Coin') as currency
       from npc_offer_sell o
       join npc n on n.article_id = o.npc_id
       left join item cur on cur.article_id = o.currency_id
       where o.item_id = ?` + (status ? ` and ${status}` : '') + `
       order by o.value asc, n.title asc`,
    );
  };
  const quests = (includeInactive: boolean) => {
    const status = statusClause('q', includeInactive);
    return db.prepare(
      `select q.title from quest_reward r join quest q on q.article_id = r.quest_id
       where r.item_id = ?` + (status ? ` and ${status}` : '') + ' order by q.title asc',
    );
  };

  server.registerTool(
    NAME,
    {
      description:
        'Every in-game source for one item in a single call: which creatures drop it and how ' +
        'likely, which NPCs sell it and for how much (the price the player pays), and which ' +
        'quests reward it. Prefer this over three separate lookups.',
      inputSchema: z.object({
        item_name: z.string().min(1).describe('Item page name, e.g. "Dragon Shield".'),
        include_inactive: z.boolean().default(false)
          .describe('Include deprecated or event-only creatures, NPCs and quests as sources.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ item_name, include_inactive }) => {
      const item = findItem.get(item_name) as
        | { article_id: number; title: string; status: string | null }
        | undefined;
      if (!item) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `No item named "${item_name}" in the index. Use tibia_search with ` +
              'types: ["item"] to find the exact page name.',
          }],
        };
      }

      const id = item.article_id;
      const droppedBy = dropped(include_inactive).all(id).map((r) => ({
        creature: String(r.creature),
        chance: r.chance === null ? null : Number(r.chance),
        min: r.lo === null ? null : Number(r.lo),
        max: r.hi === null ? null : Number(r.hi),
      }));
      const soldByNpcs = vendors(include_inactive).all(id).map((r) => ({
        npc: String(r.npc),
        city: r.city === null ? null : String(r.city),
        price: Number(r.price),
        currency: String(r.currency),
      }));
      const questRewards = quests(include_inactive).all(id).map((r) => String(r.title));

      const none =
        droppedBy.length === 0 && soldByNpcs.length === 0 && questRewards.length === 0;
      const status = item.status ?? null;
      const inactive = status !== null && status !== 'active';
      const output = {
        item: item.title,
        status,
        droppedBy,
        soldByNpcs,
        questRewards,
        note: [
          // The subject item is returned whatever its status, so the status has to be
          // stated in the payload - otherwise a non-active item reads as obtainable.
          inactive
            ? `This item's status is "${status}", so it is not obtainable on a live server ` +
              'even though sources may be listed below.'
            : '',
          none
            ? 'No creature drop, NPC vendor or quest reward is recorded for this item. Some ' +
              'items are unobtainable, event-only, or were removed from the game. Try ' +
              'include_inactive: true if it may have come from a past event.'
            : '',
        ].filter(Boolean).join(' '),
        source: sourceBlock(item.title, provenance),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
