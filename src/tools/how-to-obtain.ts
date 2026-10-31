import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { str, num, type TibiaDb } from '../db.ts';
import {
  ITEM_CLIENT_IDS, lootChanceSchema, lootMinSchema, resolveItemName, statusClause,
} from '../domain.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';
import { sourceBlock } from './get.ts';

const outputSchema = z.object({
  item: z.string(),
  articleId: z.number(),
  clientId: z.number().nullable().describe('The first client ID.'),
  clientIds: z.array(z.number()),
  status: z.string().nullable(),
  droppedBy: z.array(z.object({
    creature: z.string(),
    articleId: z.number(),
    chance: lootChanceSchema,
    min: lootMinSchema,
    max: z.number().nullable(),
  })),
  droppedByTotal: z.number(),
  nextCursor: z.string().optional(),
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
    'select article_id, title, status, client_id from item where article_id = ?');
  const clientIds = db.prepare(ITEM_CLIENT_IDS);

  const dropFrom = (includeInactive: boolean) => {
    const status = statusClause('c', includeInactive);
    return `from creature_drop d join creature c on c.article_id = d.creature_id
       where d.item_id = ?` + (status ? ` and ${status}` : '');
  };
  const droppedCount = (includeInactive: boolean) =>
    db.prepare(`select count(*) as c ${dropFrom(includeInactive)}`);
  // A total order, so a cursor's offset neither repeats nor skips a row across pages.
  // Rows can match in every column (Rootthing Nutshell drops Ruthless Axe in two identical
  // rows), so the rowid breaks the last tie and keeps each one, in a stable order. Once
  // droppedBy reports rarity, it joins the order after max, before c.article_id.
  const dropped = (includeInactive: boolean) => db.prepare(
    `select c.title as creature, c.article_id, d.chance, d.min as lo, d.max as hi
     ${dropFrom(includeInactive)}
     order by (d.chance is null), d.chance desc, c.title asc, d.min asc, d.max asc,
              c.article_id asc, d.rowid asc
     limit ? offset ?`,
  );
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
       order by o.value asc, n.title asc, currency asc`,
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
        item_name: z.string().min(1)
          .describe('Item page name or the name the game prints, e.g. "Dragon Shield".'),
        include_inactive: z.boolean().default(false)
          .describe('Include deprecated or event-only creatures, NPCs and quests as sources.'),
        limit: z.number().int().min(1).max(100).default(100)
          .describe('Pages droppedBy only. NPCs and quests come whole on every page.'),
        cursor: z.string().optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ item_name, include_inactive, limit, cursor }) => {
      let offset: number;
      try {
        offset = decodeCursor(cursor);
      } catch {
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid cursor: ${cursor}. Omit it to start over.` }],
        };
      }
      const found = resolveItemName(db, item_name);
      if (found.length > 1) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `"${item_name}" is ambiguous, several items go by it: ` +
              `${found.map((i) => i.title).join(', ')}. Call tibia_how_to_obtain again with ` +
              'one of them.',
          }],
        };
      }
      const [match] = found;
      const item = match === undefined
        ? undefined
        : findItem.get(match.articleId) as
          { article_id: number; title: string; status: string | null; client_id: number | null };
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
      const droppedByTotal = Number((droppedCount(include_inactive).get(id) as { c: number }).c);
      const droppedBy = dropped(include_inactive).all(id, limit, offset).map((r) => ({
        creature: String(r.creature),
        articleId: Number(r.article_id),
        chance: num(r.chance),
        min: num(r.lo),
        max: num(r.hi),
      }));
      const soldByNpcs = vendors(include_inactive).all(id).map((r) => ({
        npc: String(r.npc),
        city: str(r.city),
        price: Number(r.price),
        currency: String(r.currency),
      }));
      const questRewards = quests(include_inactive).all(id).map((r) => String(r.title));

      const nextCursor = offset + limit < droppedByTotal ? encodeCursor(offset + limit) : undefined;
      const none =
        droppedByTotal === 0 && soldByNpcs.length === 0 && questRewards.length === 0;
      const status = item.status ?? null;
      const inactive = status !== null && status !== 'active';
      const output = {
        item: item.title,
        articleId: item.article_id,
        clientId: num(item.client_id),
        clientIds: clientIds.all(id).map((c) => Number(c.client_id)),
        status,
        droppedBy,
        droppedByTotal,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
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
          nextCursor !== undefined
            ? `droppedBy holds ${droppedBy.length} of ${droppedByTotal} creature drops. Call ` +
              'tibia_how_to_obtain again with cursor set to nextCursor for the next page.'
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
