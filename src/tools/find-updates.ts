import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from '../db.ts';
import { encodeCursor, decodeCursor } from '../cursor.ts';

const outputSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    name: z.string().nullable(),
    releaseDate: z.string(),
    version: z.string().nullable(),
    updateType: z.string().nullable(),
    summary: z.string().nullable(),
    matchingLines: z.array(z.string()),
  })),
  totalMatches: z.number(),
  nextCursor: z.string().optional(),
  indexGeneratedAt: z.string(),
});

export const NAME = 'tibia_find_updates';

const MAX_LINES = 5;
const MAX_LINE_LENGTH = 200;
const DATE_MESSAGE = 'must be a real calendar date written YYYY-MM-DD, e.g. "2026-06-16"';

/** A real calendar date: `2026-02-30` has the shape but rolls over to March. */
const releaseDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, DATE_MESSAGE)
  .refine((s) => {
    const date = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === s;
  }, DATE_MESSAGE);

/**
 * SQLite's lower() folds ASCII only, so the lines are folded the same way: a line is
 * returned exactly when the SQL filter would match it.
 */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * A matching line, trimmed and cut to MAX_LINE_LENGTH around its first match, so a
 * long line still shows the text it was returned for. asciiLower keeps every index,
 * so a position in the folded line is the same position in the original.
 */
function excerpt(line: string, needle: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= MAX_LINE_LENGTH) return trimmed;
  const at = asciiLower(trimmed).indexOf(needle);
  const centred = at - Math.floor((MAX_LINE_LENGTH - needle.length) / 2);
  const start = Math.max(0, Math.min(centred, trimmed.length - MAX_LINE_LENGTH));
  return trimmed.slice(start, start + MAX_LINE_LENGTH).trim();
}

/** `text` is a literal: LIKE's wildcards and the escape character match themselves. */
const likeLiteral = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function registerFindUpdates(server: McpServer, handle: TibiaDb): void {
  const { db, provenance } = handle;

  server.registerTool(
    NAME,
    {
      description:
        'Find Tibia game updates by text and release date, for questions like "what changed ' +
        'for knights in 2026" or "which update added X". Matches the update\'s page title, ' +
        'name, summary and change list, newest first, and returns the change lines that ' +
        'contain the text. Date bounds are inclusive. For the full changes, call tibia_get ' +
        'with type "update" and the returned title.',
      inputSchema: z.object({
        text: z.string().min(1).optional()
          .describe('Literal substring, case-insensitive, e.g. "knight".'),
        released_after: releaseDate.optional().describe('YYYY-MM-DD, inclusive.'),
        released_before: releaseDate.optional().describe('YYYY-MM-DD, inclusive.'),
        limit: z.number().int().min(1).max(50).default(10),
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
      const params: string[] = [];
      const needle = args.text === undefined ? undefined : asciiLower(args.text);
      if (needle !== undefined) {
        const columns = ['title', 'name', 'summary', 'changes'];
        where.push(`(${columns.map((c) => `lower(u.${c}) like ? escape '\\'`).join(' or ')})`);
        params.push(...columns.map(() => `%${likeLiteral(needle)}%`));
      }
      if (args.released_after !== undefined) {
        where.push('u.release_date >= ?');
        params.push(args.released_after);
      }
      if (args.released_before !== undefined) {
        where.push('u.release_date <= ?');
        params.push(args.released_before);
      }

      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const total = db.prepare(`select count(*) c from game_update u ${clause}`).get(...params) as
        { c: number };
      const rows = db
        .prepare(
          `select u.title, u.name, u.release_date, u.version, u.type_primary, u.summary, u.changes
           from game_update u ${clause} order by u.release_date desc, u.title asc limit ? offset ?`,
        )
        .all(...params, args.limit, offset);

      const output = {
        results: rows.map((row) => ({
          title: String(row.title),
          name: row.name === null ? null : String(row.name),
          releaseDate: String(row.release_date),
          version: row.version === null ? null : String(row.version),
          updateType: row.type_primary === null ? null : String(row.type_primary),
          summary: row.summary === null ? null : String(row.summary),
          matchingLines: needle === undefined || row.changes === null ? [] : String(row.changes)
            .split('\n')
            .filter((line) => asciiLower(line).includes(needle))
            .slice(0, MAX_LINES)
            .map((line) => excerpt(line, needle)),
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
