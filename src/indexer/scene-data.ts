import type { AreaPattern } from '../area.ts';

/**
 * Parses `Module:SceneBuilder/data`, whose entries look like:
 *
 *   ["8sqmwave"] = {{
 *   0,0,0,0,0,0,1,1,1,
 *   ...
 *   0,0,0,0,0,0,1,1,1},
 *   9},
 *
 * Two traps, both of which produce a plausible wrong answer rather than an error:
 *
 * 1. Twenty of the 114 keys are written with single quotes (`['rootkraken1']`).
 *    A double-quote-only pattern returns exactly 94 entries and looks self-consistent.
 * 2. The key itself can contain digits. Scraping numbers from the whole entry picks
 *    up the `8` in `"8sqmwave"` and yields 46 values for a 45-cell grid, so the key
 *    and the body are matched separately.
 */
const ENTRY = /\[(?:"([^"]+)"|'([^']+)')\]\s*=\s*\{\s*\{([^}]*)\}\s*,\s*([^}]*)\}/g;

export type SceneDataResult = {
  patterns: AreaPattern[];
  rejected: Array<{ key: string; reason: string }>;
};

/** Validates rather than trusts: a malformed entry is reported, never reshaped. */
export function parseSceneData(lua: string): SceneDataResult {
  const patterns: AreaPattern[] = [];
  const rejected: Array<{ key: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const match of lua.matchAll(ENTRY)) {
    const key = match[1] ?? match[2]!;
    // Width is captured loosely and validated here. Demanding \d+ in the pattern
    // instead makes a malformed width (`-2`) fail to match the entry at all, so it
    // yields neither a pattern nor a rejection - invisible, which is the one
    // outcome this function promises never to produce.
    const rawWidth = match[4]!.trim();
    const width = Number(rawWidth);
    const body = match[3]!;

    if (seen.has(key)) {
      rejected.push({ key, reason: 'duplicate key' });
      continue;
    }
    seen.add(key);

    if (!/^\d+$/.test(rawWidth) || width <= 0) {
      rejected.push({ key, reason: `width must be a positive integer, got "${rawWidth}"` });
      continue;
    }
    // One optional trailing comma is tolerated; an interior empty slot is not.
    // Filtering empties instead turns `{0,,1}` into a valid two-cell grid, which is
    // silent repair of malformed data rather than the promised rejection.
    const tokens = body.replace(/,\s*$/, '').split(',').map((t) => t.trim());
    if (tokens.some((t) => !/^\d+$/.test(t))) {
      rejected.push({ key, reason: 'cells must be non-negative integers with no empty slots' });
      continue;
    }
    const cells = tokens.map(Number);
    if (cells.length === 0) {
      rejected.push({ key, reason: 'no cells' });
      continue;
    }
    if (cells.length % width !== 0) {
      rejected.push({ key, reason: `${cells.length} cells do not fill a width of ${width}` });
      continue;
    }
    patterns.push({ key, width, cells });
  }

  return { patterns, rejected };
}
