import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from '../db.ts';
import { QUEST_SORTS, questSort, statusClause, likePattern } from '../domain.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

const outputSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    location: z.string().nullable(),
    levelRequired: z.number().nullable(),
    levelRecommended: z.number().nullable(),
    isPremium: z.boolean().nullable(),
    estimatedTime: z.string().nullable(),
    rewards: z.array(z.string()),
  })),
  totalMatches: z.number(),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export const NAME = 'tibia_find_quests';

export function registerFindQuests(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  // quest_reward holds some pairs twice (The Lightbearer's Ring of Healing), hence distinct.
  const rewards = db.prepare(
    `select distinct i.title from quest_reward r join item i on i.article_id = r.item_id
     where r.quest_id = ? order by i.title asc`);

  server.registerTool(
    NAME,
    {
      description:
        'Find Tibia quests by level, premium, Rookgaard and location, with their rewards. Use ' +
        'this for questions like "which quests can a level 20 character do". Call tibia_get ' +
        'with a title for the legend and dangers.',
      inputSchema: z.object({
        level_max: z.number().int().nonnegative().optional()
          .describe('Highest level the character has. Quests with no level requirement always match.'),
        is_premium: z.boolean().optional(),
        is_rookgaard: z.boolean().optional(),
        location_contains: z.string().min(1).optional()
          .describe('Literal substring of the location, case-insensitive.'),
        include_inactive: z.boolean().default(false),
        sort: z.enum(QUEST_SORTS).default('level_recommended')
          .describe('Levels ascend, title is alphabetical. Unknown levels come last.'),
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
      const bind = (clause: string, value: string | number) => {
        where.push(clause);
        params.push(value);
      };
      // A required level of 0 or null is no requirement, so both pass any level_max.
      if (args.level_max !== undefined) bind('coalesce(q.level_required, 0) <= ?', args.level_max);
      if (args.is_premium !== undefined) bind('q.is_premium = ?', args.is_premium ? 1 : 0);
      if (args.is_rookgaard !== undefined) bind('q.is_rookgaard_quest = ?', args.is_rookgaard ? 1 : 0);
      if (args.location_contains !== undefined) {
        bind(`lower(q.location) like ? escape '\\'`, likePattern(args.location_contains));
      }
      const status = statusClause('q', args.include_inactive);
      if (status) where.push(status);

      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const total = db.prepare(`select count(*) c from quest q ${clause}`).get(...params) as
        { c: number };
      const rows = db
        .prepare(`select q.* from quest q ${clause} order by ${questSort(args.sort)} limit ? offset ?`)
        .all(...params, args.limit, offset);

      const str = (v: unknown): string | null => (v === null ? null : String(v));
      const num = (v: unknown): number | null => (v === null ? null : Number(v));
      const output = {
        results: rows.map((row) => ({
          title: String(row.title),
          location: str(row.location),
          levelRequired: num(row.level_required),
          levelRecommended: num(row.level_recommended),
          isPremium: row.is_premium === null ? null : Boolean(row.is_premium),
          estimatedTime: str(row.estimated_time),
          rewards: rewards.all(row.article_id as number).map((r) => String(r.title)),
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
