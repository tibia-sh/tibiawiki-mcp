import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderArea, AREA_LEGEND } from '../src/area.ts';
import { parseSceneData } from '../src/indexer/scene-data.ts';

/**
 * The fixture is `Module:SceneBuilder/data` committed verbatim. Malformed cases are
 * passed inline instead, so they cannot contradict the 114-pattern count on the file.
 */
const LUA = readFileSync(new URL('./fixtures/scene-data.lua', import.meta.url), 'utf8');
const parsed = parseSceneData(LUA);
const byKey = (key: string) => parsed.patterns.find((p) => p.key === key);

// Expected grids were read off the module data, not produced by renderArea.
const WAVE = [
  '. . . . . . # # #',
  '. . . # # # # # #',
  '@ # # # # # # # #',
  '. . . * # # # # #',
  '. . . . . . # # #',
].join('\n');

test('the module defines 114 patterns, including single-quoted keys', () => {
  assert.equal(parsed.patterns.length, 114);
  // The count alone is tautological: a double-quote-only regex yields exactly 94
  // and would pass a bare length check. These keys are written ['key'].
  assert.ok(byKey('rootkraken1'), 'rootkraken1 is single-quoted and must parse');
  assert.ok(byKey('rootkraken2'), 'rootkraken2 is single-quoted and must parse');
  assert.equal(parsed.rejected.length, 0);
});

test('8sqmwave renders the documented 5x9 cone', () => {
  const p = byKey('8sqmwave');
  assert.ok(p);
  assert.equal(p.cells.length, 45);
  assert.equal(p.width, 9);
  const area = renderArea(p, { effectOnCaster: false });
  assert.equal(area.height, 5);
  assert.equal(area.ascii, WAVE);
});

test('cell 3 is the target tile, never a direction marker', () => {
  const area = renderArea(byKey('8sqmwave')!, { effectOnCaster: false });
  assert.ok(area.ascii.includes('*'), 'target glyph must be present');
  assert.ok(!area.ascii.includes('>'), '3 is target_element, not a direction');
});

test('rootkraken1 is 13 rows and keeps its extra-sprite cells', () => {
  const p = byKey('rootkraken1');
  assert.ok(p);
  assert.equal(p.cells.length, 117);
  const area = renderArea(p, { effectOnCaster: false });
  assert.equal(area.height, 13);
  assert.ok(area.ascii.includes('4'), 'extra_sprite_1 cells render as their digit');
});

test('effectTiles counts effect cells only', () => {
  const p = byKey('rootkraken1')!;
  const area = renderArea(p, { effectOnCaster: false });
  assert.equal(area.effectTiles, p.cells.filter((c) => c === 1).length);
  // The grid also holds 2, 3 and 4 cells, which must not be counted as effect.
  assert.ok(p.cells.includes(2) && p.cells.includes(3) && p.cells.includes(4));
  assert.ok(area.effectTiles < p.cells.filter((c) => c !== 0).length);
});

test('effectOnCaster is passed through, never inferred from the grid', () => {
  const p = byKey('8sqmwave')!;
  const on = renderArea(p, { effectOnCaster: true });
  const off = renderArea(p, { effectOnCaster: false });
  assert.equal(on.effectOnCaster, true);
  assert.equal(off.effectOnCaster, false);
  assert.equal(on.ascii, off.ascii);
});

test('the legend describes every glyph it can render', () => {
  // Shipped once in the tool description, so it must explain all of them.
  for (const word of [/unaffected/i, /effect/i, /caster/i, /target/i, /sprite/i]) {
    assert.match(AREA_LEGEND, word);
  }
});

test('a grid whose cells do not fill its width is rejected with a reason', () => {
  const r = parseSceneData(`["bad"] = {{0,1,0,1,0}, 2}`);
  assert.equal(r.patterns.length, 0);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0]!.key, 'bad');
  assert.match(r.rejected[0]!.reason, /do not fill a width/);
});

test('a malformed width is rejected, not made invisible', () => {
  // Demanding \d+ in the entry pattern makes this fail to match the entry at all,
  // so it produces neither a pattern nor a rejection - the one outcome the parser
  // promises never to produce.
  const r = parseSceneData(`["bad"] = {{0,1,0,1}, -2}`);
  assert.equal(r.patterns.length, 0);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0]!.reason, /positive integer/);
});

test('an interior empty cell slot is rejected, not silently repaired', () => {
  // Filtering empty tokens turns this into a valid two-cell grid that the runtime
  // would then serve as authoritative.
  const r = parseSceneData(`["gap"] = {{0,,1}, 2}`);
  assert.equal(r.patterns.length, 0);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0]!.reason, /empty slot/);
});

test('a single trailing comma is tolerated', () => {
  // Two entries in the real module end this way; rejecting them would drop them.
  const r = parseSceneData(`["ok"] = {{0,1,0,1,}, 2}`);
  assert.equal(r.rejected.length, 0);
  assert.deepEqual(r.patterns[0]!.cells, [0, 1, 0, 1]);
});

test('a duplicate key is rejected rather than silently overwritten', () => {
  const r = parseSceneData(`["dup"] = {{0,1}, 2}\n["dup"] = {{1,0}, 2}`);
  assert.equal(r.patterns.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0]!.reason, /duplicate/i);
});

test('a key containing digits does not leak them into the grid', () => {
  // ["8sqmwave"] = {{...}, 9}: a naive numeric scrape picks up the leading 8
  // and yields 46 values for a 45-cell grid.
  const r = parseSceneData(`["8sqmwave"] = {{0,1,0,1}, 2}`);
  assert.equal(r.rejected.length, 0);
  assert.deepEqual(r.patterns[0]!.cells, [0, 1, 0, 1]);
});

test('an out-of-range cell value degrades visibly', () => {
  const r = parseSceneData(`["odd"] = {{0,9}, 2}`);
  assert.equal(r.patterns.length, 1);
  assert.equal(renderArea(r.patterns[0]!, { effectOnCaster: false }).ascii, '. ?');
});
