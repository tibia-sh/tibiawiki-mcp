import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { str, num, type TibiaDb } from '../db.ts';
import {
  ELEMENTS, elementSchema, modifierColumn, WEAK_TO, RESISTANT_TO,
  CREATURE_SORTS, creatureSort, statusClause, hitpointsExpr,
} from '../domain.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

const outputSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    hitpoints: z.number().nullable(),
    experience: z.number().nullable(),
    bestiaryClass: z.string().nullable(),
    isBoss: z.boolean(),
    modifiers: z.record(z.string(), z.number().nullable()),
  })),
  totalMatches: z.number(),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export const NAME = 'tibia_find_creatures';

export function registerFindCreatures(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  server.registerTool(
    NAME,
    {
      description:
        'Find Tibia creatures matching stat filters. Damage modifiers are percentages where ' +
        '100 is neutral: "weak_to" means the creature takes MORE than 100% damage from that ' +
        'element, "resistant_to" means less. Use this for questions like "which creatures are ' +
        'weak to fire and give over 500 experience".',
      inputSchema: z.object({
        weak_to: z.array(elementSchema).optional()
          .describe('Elements the creature takes extra damage from.'),
        resistant_to: z.array(elementSchema).optional(),
        experience_min: z.number().int().optional(),
        experience_max: z.number().int().optional(),
        hitpoints_min: z.number().int().optional()
          .describe('Creatures whose hitpoints are unrecorded are excluded from this filter.'),
        hitpoints_max: z.number().int().optional()
          .describe('Creatures whose hitpoints are unrecorded are excluded from this filter.'),
        bestiary_class: z.string().optional().describe('e.g. "Dragon", "Human".'),
        is_boss: z.boolean().optional(),
        location_contains: z.string().optional().describe('Substring of the location text.'),
        include_inactive: z.boolean().default(false),
        sort: z.enum(CREATURE_SORTS).default('experience'),
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

      // Element predicates come from the closed maps in domain.ts. Every other
      // filter binds a parameter; no user value is ever interpolated.
      for (const e of args.weak_to ?? []) where.push(WEAK_TO(`c.${modifierColumn(e)}`));
      for (const e of args.resistant_to ?? []) where.push(RESISTANT_TO(`c.${modifierColumn(e)}`));
      const bind = (clause: string, value: string | number) => {
        where.push(clause);
        params.push(value);
      };
      if (args.experience_min !== undefined) bind('c.experience >= ?', args.experience_min);
      if (args.experience_max !== undefined) bind('c.experience <= ?', args.experience_max);
      if (args.hitpoints_min !== undefined) bind(`${hitpointsExpr('c')} >= ?`, args.hitpoints_min);
      if (args.hitpoints_max !== undefined) bind(`${hitpointsExpr('c')} <= ?`, args.hitpoints_max);
      if (args.bestiary_class !== undefined) bind('c.bestiary_class = ? collate nocase', args.bestiary_class);
      if (args.is_boss !== undefined) bind('c.is_boss = ?', args.is_boss ? 1 : 0);
      if (args.location_contains !== undefined) {
        bind('c.location like ? collate nocase', `%${args.location_contains}%`);
      }
      const status = statusClause('c', args.include_inactive);
      if (status) where.push(status);

      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const total = db.prepare(`select count(*) c from creature c ${clause}`).get(...params) as
        { c: number };
      const rows = db
        .prepare(
          `select c.* from creature c ${clause} order by ${creatureSort(args.sort)} limit ? offset ?`,
        )
        .all(...params, args.limit, offset);

      const output = {
        results: rows.map((row) => ({
          title: String(row.title),
          // 0 means unrecorded; report it as null rather than as a real value.
          hitpoints: !row.hitpoints ? null : Number(row.hitpoints),
          experience: num(row.experience),
          bestiaryClass: str(row.bestiary_class),
          isBoss: Boolean(row.is_boss),
          modifiers: Object.fromEntries(
            ELEMENTS.map((e) => {
              const v = row[`modifier_${e}`];
              return [e, num(v)];
            }),
          ),
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
