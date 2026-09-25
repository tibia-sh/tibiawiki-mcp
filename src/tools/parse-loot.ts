import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { num, type TibiaDb } from '../db.ts';
import {
  BEST_GOLD_PRICE, coinFaceValue, resolveCreatureName, resolveItemName, titleOrder,
} from '../domain.ts';

const candidatesSchema = z.array(z.string()).describe('Titles it may mean, when more than one.');

const entrySchema = z.object({
  text: z.string(),
  count: z.number().nullable().describe('Null: no count from 1 to 1,000,000.'),
  item: z.string().nullable().describe('Item title. Null: no single item.'),
  candidates: candidatesSchema,
  clientId: z.number().nullable(),
  unitPrice: z.number().nullable().describe('Coin face value, else best NPC price in gold.'),
  value: z.number().nullable(),
});
type Entry = z.infer<typeof entrySchema>;

const lineSchema = z.object({
  creature: z.object({ text: z.string(), title: z.string().nullable(), candidates: candidatesSchema }),
  note: z.string().nullable(),
  items: z.array(entrySchema),
});
type Line = z.infer<typeof lineSchema>;

const outputSchema = z.object({
  lines: z.array(lineSchema).optional().describe('Each loot line, with include_lines.'),
  totals: z.object({
    items: z.array(z.object({ item: z.string(), count: z.number(), value: z.number().nullable() })),
    gold: z.number().describe('Sum of the priced values.'),
    unresolved: z.number().describe('Entries with no single item.'),
    unpriced: z.number().describe('Entries of an item with no price.'),
  }),
  unresolvedEntries: z.array(z.object({
    line: z.number().describe('Line number in the input, from 1.'),
    text: z.string(),
    candidates: candidatesSchema,
  })).describe('Entries with no single item.'),
  unparsed: z.array(z.string()).describe('Lines that are no loot message.'),
  indexGeneratedAt: z.string(),
});

export const NAME = 'tibia_parse_loot';

/**
 * A loot message: an optional HH:MM or HH:MM:SS timestamp, "Loot of <creature>: <items>",
 * an optional " (<note>)" and an optional full stop. No creature name holds a colon, so the
 * creature ends at the first one, which keeps a line that is no match from backtracking
 * over every colon in it.
 */
const LOOT_LINE = /^(?:\d{2}:\d{2}(?::\d{2})? )?Loot of ([^:]+): (.+?)(?: \(([^()]*)\))?\.?$/;

/** The largest count read, which keeps every value and total an exact integer. */
const MAX_COUNT = 1_000_000;

/**
 * An entry's item name and count: "a <name>", "an <name>" and a bare name count 1, and
 * "<count> <name>" counts from 1 to MAX_COUNT. Null when the entry leads with a number that
 * is no such count.
 */
function readEntry(text: string): { name: string; count: number } | null {
  const article = /^an? (.+)$/.exec(text);
  if (article) return { name: article[1]!, count: 1 };
  const counted = /^(\S+) (.+)$/.exec(text);
  if (!counted || !/^[-+.]?\d/.test(counted[1]!)) return { name: text, count: 1 };
  const count = /^\d+$/.test(counted[1]!) ? Number(counted[1]) : NaN;
  return count >= 1 && count <= MAX_COUNT ? { name: counted[2]!, count } : null;
}

export function registerParseLoot(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;
  // BEST_GOLD_PRICE ranks every offer, so it runs once for the whole text.
  const itemFacts = db.prepare(
    `select i.article_id, i.client_id, best.price
       from item i
       left join (${BEST_GOLD_PRICE}) best on best.item_id = i.article_id
      where i.article_id in (select value from json_each(?))`);

  server.registerTool(
    NAME,
    {
      description:
        'Parses loot messages as the game prints them, one per line, such as "12:34 Loot of ' +
        'a dragon: 2 small diamonds, a steel shield (active prey bonus)." Gives totals by ' +
        'item with count and value, and the entries it cannot resolve. Prices are NPC prices ' +
        'in gold, coins at face value. Other lines come back as unparsed.',
      inputSchema: z.object({
        text: z.string().min(1).max(20_000).describe('Loot messages, one per line.'),
        include_lines: z.boolean().default(false)
          .describe('Also give each line with its items, client IDs and prices.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ text, include_lines }) => {
      const lines: Line[] = [];
      const unparsed: string[] = [];
      const resolved: Array<{ entry: Entry; articleId: number }> = [];
      const unresolvedEntries: Array<{ line: number; text: string; candidates: string[] }> = [];

      for (const [index, raw] of text.split(/\r\n|\r|\n/).entries()) {
        const line = raw.trim();
        if (line === '') continue;
        const match = LOOT_LINE.exec(line);
        if (!match) {
          unparsed.push(line);
          continue;
        }
        const [, creatureText, itemsText, note] = match;
        // A name the game prints may itself begin with "a" ("a greedy eye"), so the whole
        // text is tried before the text without its article.
        let found = resolveCreatureName(db, creatureText!);
        const bare = /^an? (.+)$/.exec(creatureText!)?.[1];
        if (found.length === 0 && bare !== undefined) found = resolveCreatureName(db, bare);
        const dropsOf = found.length > 0 ? new Set(found.map((c) => c.articleId)) : undefined;

        const items: Entry[] = [];
        for (const entryText of itemsText === 'nothing' ? [] : itemsText!.split(', ')) {
          const read = readEntry(entryText);
          const matches = read ? resolveItemName(db, read.name, { count: read.count, dropsOf }) : [];
          const entry: Entry = {
            text: entryText, count: read?.count ?? null,
            item: matches.length === 1 ? matches[0]!.title : null,
            candidates: matches.length > 1 ? matches.map((i) => i.title) : [],
            clientId: null, unitPrice: null, value: null,
          };
          if (matches.length === 1) {
            resolved.push({ entry, articleId: matches[0]!.articleId });
          } else {
            unresolvedEntries.push({
              line: index + 1, text: entryText, candidates: entry.candidates,
            });
          }
          items.push(entry);
        }
        lines.push({
          creature: {
            text: creatureText!,
            title: found.length === 1 ? found[0]!.title : null,
            candidates: found.length > 1 ? found.map((c) => c.title) : [],
          },
          note: note ?? null,
          items,
        });
      }

      const facts = new Map(itemFacts.all(JSON.stringify([...new Set(resolved.map((r) => r.articleId))]))
        .map((r) => [Number(r.article_id), { clientId: num(r.client_id), price: num(r.price) }]));
      const totals = new Map<string, { item: string; count: number; value: number | null }>();
      let gold = 0;
      let unpriced = 0;
      for (const { entry, articleId } of resolved) {
        const { clientId, price } = facts.get(articleId)!;
        const item = entry.item!;
        const count = entry.count!;
        entry.clientId = clientId;
        entry.unitPrice = coinFaceValue(item) ?? price;
        entry.value = entry.unitPrice === null ? null : entry.unitPrice * count;
        if (entry.value === null) unpriced += 1;
        else gold += entry.value;
        const total = totals.get(item);
        if (total) {
          total.count += count;
          if (total.value !== null && entry.value !== null) total.value += entry.value;
        } else {
          totals.set(item, { item, count, value: entry.value });
        }
      }

      const output = {
        ...(include_lines ? { lines } : {}),
        totals: {
          items: [...totals.values()].sort((a, b) => titleOrder(a.item, b.item)),
          gold, unresolved: unresolvedEntries.length, unpriced,
        },
        unresolvedEntries,
        unparsed,
        indexGeneratedAt: provenance.generatedAt,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
