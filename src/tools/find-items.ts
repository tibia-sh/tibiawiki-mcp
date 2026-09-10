import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from '../db.ts';
import {
  ITEM_SORTS, itemSort, eavOperator, statusClause, coerceAttribute, REPORTED_ATTRS,
  type EavOperator,
} from '../domain.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';


const outputSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    itemClass: z.string().nullable(),
    itemType: z.string().nullable(),
    weight: z.number().nullable(),
    valueBuy: z.number().nullable(),
    attributes: z.record(z.string(), z.union([z.string(), z.number()])),
  })),
  totalMatches: z.number(),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export const NAME = 'tibia_find_items';

export function registerFindItems(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;
  const attrs = db.prepare('select name, value from item_attribute where item_id = ?');

  server.registerTool(
    NAME,
    {
      description:
        'Find Tibia items matching class, type and stat filters such as attack, defense, armor ' +
        'and required level. Use this for questions like "which two-handed swords need level 100 ' +
        'or less". Vocation and weapon type match by membership, so "knight" matches "knights".',
      inputSchema: z.object({
        item_class: z.string().optional().describe('e.g. "Weapons", "Armors".'),
        item_type: z.string().optional().describe('e.g. "Sword Weapons".'),
        weapon_type: z.string().optional().describe('e.g. "Sword", "Axe", "Club".'),
        vocation: z.string().optional().describe('Matches required_vocation, e.g. "knight".'),
        attack_min: z.number().int().optional(),
        attack_max: z.number().int().optional(),
        defense_min: z.number().int().optional(),
        armor_min: z.number().int().optional(),
        required_level_max: z.number().int().optional(),
        include_inactive: z.boolean().default(false),
        sort: z.enum(ITEM_SORTS).default('title'),
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

      /** Numeric EAV predicate: the cast is load-bearing, the column is TEXT. */
      const numeric = (attr: string, op: EavOperator, value: number) => {
        where.push(
          `exists (select 1 from item_attribute a where a.item_id = i.article_id
            and a.name = ? and cast(a.value as integer) ${eavOperator(op)} ?)`,
        );
        params.push(attr, value);
      };
      /** Text EAV predicate: membership, because values are comma-joined lists. */
      const text = (attr: string, value: string) => {
        where.push(
          `exists (select 1 from item_attribute a where a.item_id = i.article_id
            and a.name = ? and a.value like ? collate nocase)`,
        );
        params.push(attr, `%${value}%`);
      };
      const bind = (clause: string, value: string | number) => {
        where.push(clause);
        params.push(value);
      };

      if (args.item_class !== undefined) bind('i.item_class = ? collate nocase', args.item_class);
      if (args.item_type !== undefined) bind('i.item_type = ? collate nocase', args.item_type);
      if (args.attack_min !== undefined) numeric('attack', 'gte', args.attack_min);
      if (args.attack_max !== undefined) numeric('attack', 'lte', args.attack_max);
      if (args.defense_min !== undefined) numeric('defense', 'gte', args.defense_min);
      if (args.armor_min !== undefined) numeric('armor', 'gte', args.armor_min);
      if (args.required_level_max !== undefined) numeric('required_level', 'lte', args.required_level_max);
      if (args.weapon_type !== undefined) text('weapon_type', args.weapon_type);
      if (args.vocation !== undefined) text('required_vocation', args.vocation);
      const status = statusClause('i', args.include_inactive);
      if (status) where.push(status);

      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const total = db.prepare(`select count(*) c from item i ${clause}`).get(...params) as
        { c: number };
      const rows = db
        .prepare(`select i.* from item i ${clause} order by ${itemSort(args.sort)} limit ? offset ?`)
        .all(...params, args.limit, offset);

      const output = {
        results: rows.map((row) => {
          const bag: Record<string, string | number> = {};
          for (const a of attrs.all(row.article_id as number)) {
            const key = String(a.name);
            if (!REPORTED_ATTRS.has(key)) continue;
            bag[key] = coerceAttribute(key, a.value);
          }
          return {
            title: String(row.title),
            itemClass: row.item_class === null ? null : String(row.item_class),
            itemType: row.item_type === null ? null : String(row.item_type),
            weight: row.weight === null ? null : Number(row.weight),
            valueBuy: row.value_buy === null ? null : Number(row.value_buy),
            attributes: bag,
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
