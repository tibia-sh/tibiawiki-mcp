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
  legend: string;
};

const GLYPHS: Record<number, string> = { 0: '.', 1: '#', 2: '@', 3: '*' };

/** Committed verbatim: a model must never have to infer what a glyph means. */
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
    legend: AREA_LEGEND,
  };
}
