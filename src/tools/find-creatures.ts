import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { str, num, bool, type TibiaDb } from '../db.ts';
import {
  ELEMENTS, elementSchema, modifierColumn, WEAK_TO, RESISTANT_TO,
  CREATURE_BESTIARY_LEVELS, CREATURE_SORTS, creatureSort, statusClause, hitpointsExpr, likePattern,
  runsAtSchema, summonCostSchema, convinceCostSchema,
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
    runsAt: runsAtSchema,
    seesInvisible: z.boolean().nullable(),
    paralysable: z.boolean().nullable(),
    pushable: z.boolean().nullable(),
    summonCost: summonCostSchema,
    convinceCost: convinceCostSchema,
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
        'weak to fire and give over 500 experience". Behaviour filters skip creatures whose ' +
        'value is unrecorded.',
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
        sees_invisible: z.boolean().optional(),
        paralysable: z.boolean().optional(),
        pushable: z.boolean().optional(),
        summonable: z.boolean().optional().describe('true: summon cost above 0. false: 0.'),
        convinceable: z.boolean().optional().describe('true: convince cost above 0. false: 0.'),
        bestiary_level: z.enum(CREATURE_BESTIARY_LEVELS).optional()
          .describe('Creatures with no recorded bestiary level are excluded from this filter.'),
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
      // The wiki records these as 0 or 1, or not at all, so an unrecorded one never matches.
      if (args.sees_invisible !== undefined) bind('c.sees_invisible = ?', args.sees_invisible ? 1 : 0);
      if (args.paralysable !== undefined) bind('c.paralysable = ?', args.paralysable ? 1 : 0);
      if (args.pushable !== undefined) bind('c.pushable = ?', args.pushable ? 1 : 0);
      // A cost of 0 is the wiki's way of saying it cannot be done.
      if (args.summonable !== undefined) where.push(`c.summon_cost ${args.summonable ? '> 0' : '= 0'}`);
      if (args.convinceable !== undefined) where.push(`c.convince_cost ${args.convinceable ? '> 0' : '= 0'}`);
      if (args.bestiary_level !== undefined) bind('c.bestiary_level = ? collate nocase', args.bestiary_level);
      if (args.location_contains !== undefined) {
        bind(`lower(c.location) like ? escape '\\'`, likePattern(args.location_contains));
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
          runsAt: num(row.runs_at),
          seesInvisible: bool(row.sees_invisible),
          paralysable: bool(row.paralysable),
          pushable: bool(row.pushable),
          summonCost: num(row.summon_cost),
          convinceCost: num(row.convince_cost),
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
