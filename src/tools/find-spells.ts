import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { str, num, bool, type TibiaDb } from '../db.ts';
import {
  SPELL_ELEMENTS, SPELL_VOCATIONS, vocationColumn, SPELL_GROUPS, SPELL_TYPES,
  SPELL_SORTS, spellSort, statusClause,
} from '../domain.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

const outputSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    words: z.string().nullable(),
    spellType: z.string().nullable(),
    group: z.string().nullable(),
    element: z.string().nullable(),
    level: z.number().nullable(),
    mana: z.number().nullable(),
    vocations: z.array(z.enum(SPELL_VOCATIONS)),
    isPremium: z.boolean().nullable(),
    isPromotion: z.boolean().nullable(),
  })),
  totalMatches: z.number(),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export const NAME = 'tibia_find_spells';

export function registerFindSpells(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  server.registerTool(
    NAME,
    {
      description:
        'Find Tibia spells by vocation, level, group, element and type. Use this for questions ' +
        'like "which healing spells can a level 30 druid cast". Call tibia_get with a title for ' +
        'cooldowns, effect and area.',
      inputSchema: z.object({
        vocation: z.enum(SPELL_VOCATIONS).optional(),
        level_max: z.number().int().nonnegative().optional().describe('Highest level the caster has.'),
        group: z.enum(SPELL_GROUPS).optional()
          .describe('Runes are all filed under support, so find attack runes by spell_type and element.'),
        element: z.enum(SPELL_ELEMENTS).optional()
          .describe('Damage element. For healing spells, use group.'),
        spell_type: z.enum(SPELL_TYPES).optional(),
        is_premium: z.boolean().optional(),
        include_inactive: z.boolean().default(false),
        sort: z.enum(SPELL_SORTS).default('level')
          .describe(
            'level and mana ascend, title is alphabetical. Spells with a variable cost ' +
            '(party spells) store mana 0, so they come first by mana.',
          ),
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

      // The vocation column comes from the closed list in domain.ts. Every other
      // filter binds a parameter, so no user value is ever interpolated.
      if (args.vocation !== undefined) where.push(`s.${vocationColumn(args.vocation)} = 1`);
      const bind = (clause: string, value: string | number) => {
        where.push(clause);
        params.push(value);
      };
      if (args.level_max !== undefined) bind('s.level <= ?', args.level_max);
      // The columns hold "Healing", "Fire" and "Rune", the inputs are lowercase.
      if (args.group !== undefined) bind('s.group_spell = ? collate nocase', args.group);
      if (args.element !== undefined) bind('s.element = ? collate nocase', args.element);
      if (args.spell_type !== undefined) bind('s.spell_type = ? collate nocase', args.spell_type);
      if (args.is_premium !== undefined) bind('s.is_premium = ?', args.is_premium ? 1 : 0);
      const status = statusClause('s', args.include_inactive);
      if (status) where.push(status);

      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const total = db.prepare(`select count(*) c from spell s ${clause}`).get(...params) as
        { c: number };
      const rows = db
        .prepare(`select s.* from spell s ${clause} order by ${spellSort(args.sort)} limit ? offset ?`)
        .all(...params, args.limit, offset);

      const output = {
        results: rows.map((row) => ({
          title: String(row.title),
          words: str(row.words),
          spellType: str(row.spell_type),
          group: str(row.group_spell),
          element: str(row.element),
          level: num(row.level),
          mana: num(row.mana),
          vocations: SPELL_VOCATIONS.filter((v) => Number(row[v]) === 1),
          isPremium: bool(row.is_premium),
          isPromotion: bool(row.is_promotion),
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
