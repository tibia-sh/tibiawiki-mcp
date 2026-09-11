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
const ENTRY = /\[(?:"([^"]+)"|'([^']+)')\]\s*=\s*\{\s*\{([^}]*)\}\s*,\s*(\d+)\s*\}/g;

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
    const width = Number(match[4]);
    const body = match[3]!;

    if (seen.has(key)) {
      rejected.push({ key, reason: 'duplicate key' });
      continue;
    }
    seen.add(key);

    if (!Number.isInteger(width) || width <= 0) {
      rejected.push({ key, reason: `width must be a positive integer, got ${match[4]}` });
      continue;
    }
    const tokens = body.split(',').map((t) => t.trim()).filter((t) => t !== '');
    if (tokens.some((t) => !/^\d+$/.test(t))) {
      rejected.push({ key, reason: 'cells must be non-negative integers' });
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
