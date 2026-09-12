/**
 * Spell and ability area-of-effect grids.
 *
 * TibiaWiki draws these as animated GIFs, which a model cannot read: animations are
 * unsupported and only the first frame is used. The underlying tile grid is wiki text,
 * so it can be served as something a model reasons over instead of looks at.
 *
 * Cell semantics come from `Module:SceneBuilder`'s own `elements` table:
 *   [0] tile_only  [1] effect  [2] caster  [3] target  [4]-[8] extra_sprite_1..5
 * `3` is the target tile, not a direction — direction lives in the Scene's
 * `look_direction` argument, which this module deliberately does not model.
 */

export type AreaPattern = { key: string; width: number; cells: number[] };

export type Area = {
  key: string;
  width: number;
  height: number;
  cells: number[];
  ascii: string;
  effectTiles: number;
  effectOnCaster: boolean;
};

const GLYPHS: Record<number, string> = { 0: '.', 1: '#', 2: '@', 3: '*' };

/**
 * Committed verbatim: a model must never have to infer what a glyph means. Carried
 * once in `tibia_get`'s description rather than on every Area - a creature with six
 * abilities would otherwise repeat this string six times in one response.
 */
export const AREA_LEGEND =
  'Grid of map tiles, row-major, as the caster faces. ' +
  "'.' unaffected tile, '#' effect tile, '@' the caster, '*' the target tile, " +
  "digits 4-8 extra sprite layers (a second effect the scene draws), '?' an " +
  'unrecognised value. effectTiles counts effect tiles only. effectOnCaster says ' +
  'whether the caster is caught in its own effect; it is stated by the wiki, not ' +
  'read off the grid.';

function glyph(value: number): string {
  if (Object.hasOwn(GLYPHS, value)) return GLYPHS[value]!;
  return value >= 4 && value <= 8 ? String(value) : '?';
}

/**
 * `effectOnCaster` is an input, not a derivation. Cell values are mutually exclusive,
 * so the caster tile is `2` and can never also read as `1`; whether the caster is
 * inside the effect is only knowable from the Scene's `effect_on_caster` argument.
 */
export function renderArea(pattern: AreaPattern, opts: { effectOnCaster: boolean }): Area {
  const { key, width, cells } = pattern;
  const height = cells.length / width;
  const rows: string[] = [];
  for (let r = 0; r < height; r += 1) {
    rows.push(cells.slice(r * width, (r + 1) * width).map(glyph).join(' '));
  }
  return {
    key,
    width,
    height,
    cells,
    ascii: rows.join('\n'),
    effectTiles: cells.filter((c) => c === 1).length,
    effectOnCaster: opts.effectOnCaster,
  };
}

/**
 * A decoded spell area: a binary mask, not the labelled grid above.
 *
 * `Mask` lives here rather than beside the decoder because `src/` must never import
 * from `scripts/` - `tsconfig.build.json` sets `rootDir: src`, so even a type-only
 * import that way is TS6059 and fails the build. The decoder imports this instead.
 */
export type Mask = { width: number; height: number; cells: number[] };

export type SpellShape = {
  width: number;
  height: number;
  cells: number[];
  ascii: string;
  affectedTiles: number;
  derivedFrom: 'animation';
  sourceImage: string;
  sourceUrl: string;
  corroborated: boolean;
};

/**
 * Crops to the affected bounding box.
 *
 * Every image-to-image comparison must go through this. Comparing raw canvases
 * reports a conflict between two images that agree: TibiaWiki's two Energy Beam
 * animations decode to a cell-identical 1x5 on canvases of 3x8 and 3x9.
 */
export function normaliseMask(mask: Mask): Mask {
  const ys: number[] = [];
  const xs: number[] = [];
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.cells[y * mask.width + x]) { ys.push(y); xs.push(x); }
    }
  }
  if (ys.length === 0) return { width: 0, height: 0, cells: [] };
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const width = x1 - x0 + 1;
  const cells: number[] = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) cells.push(mask.cells[y * mask.width + x]!);
  }
  return { width, height: y1 - y0 + 1, cells };
}

/** Only two glyphs: the decode cannot recover caster, target or sprite tiles. */
export function renderSpellShape(input: {
  width: number; height: number; cells: number[];
  sourceImage: string; sourceUrl: string; corroborated: boolean;
}): SpellShape {
  const { width, height, cells } = input;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`Spell shape dimensions must be positive integers, got ${width}x${height}.`);
  }
  if (cells.length !== width * height) {
    throw new Error(`Spell shape has ${cells.length} cells for a ${width}x${height} grid.`);
  }
  if (cells.some((c) => c !== 0 && c !== 1)) {
    throw new Error('Spell shape cells must be 0 or 1; the decode produces a binary mask.');
  }
  const rows: string[] = [];
  for (let r = 0; r < height; r += 1) {
    rows.push(cells.slice(r * width, (r + 1) * width).map((c) => (c ? '#' : '.')).join(' '));
  }
  return {
    width, height, cells,
    ascii: rows.join('\n'),
    affectedTiles: cells.filter((c) => c === 1).length,
    derivedFrom: 'animation',
    sourceImage: input.sourceImage,
    sourceUrl: input.sourceUrl,
    corroborated: input.corroborated,
  };
}
