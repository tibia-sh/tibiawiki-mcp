import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normaliseMask, type Mask } from '../src/area.ts';
import { decideSpell, isAreaCandidate } from '../scripts/spell-decode.ts';

type Entry = {
  width: number; height: number; cells: number[]; affectedTiles: number;
  corroborated: boolean; sources: Array<{ image: string; url: string; revision: string }>;
};
type Data = {
  decoderVersion: number;
  spells: Record<string, Entry>;
  excluded: Record<string, { reason: string; sources: Array<{ image: string; shape: string }> }>;
  stats: Record<string, number>;
};

const read = <T>(rel: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as T;

const data = read<Data>('../data/spell-areas.json');

test('every entry is a well-formed binary mask', () => {
  const bad: string[] = [];
  for (const [spell, e] of Object.entries(data.spells)) {
    if (e.cells.length !== e.width * e.height) bad.push(`${spell}: ${e.cells.length} cells for ${e.width}x${e.height}`);
    if (e.cells.some((c) => c !== 0 && c !== 1)) bad.push(`${spell}: non-binary cell`);
    if (e.affectedTiles !== e.cells.filter((c) => c === 1).length) bad.push(`${spell}: affectedTiles disagrees`);
    if (e.sources.length === 0) bad.push(`${spell}: no source recorded`);
  }
  assert.deepEqual(bad, []);
});

test('Avalanche is a 37-tile circle', () => {
  const a = data.spells['Avalanche'];
  assert.ok(a, 'Avalanche must be served');
  assert.equal(a.width, 7);
  assert.equal(a.height, 7);
  assert.equal(a.affectedTiles, 37);
});

/**
 * The draft-1 regression, in both directions. Great Energy Beam's two images really
 * do disagree (1x7 vs 1x8). Energy Beam's do NOT - they decode to a cell-identical
 * 1x5 on canvases of 3x8 and 3x9 - and calling that a conflict cost a plan round.
 */
test('only genuinely disagreeing images are excluded', () => {
  assert.ok(data.excluded['Great Energy Beam'], 'the real conflict must be excluded');
  assert.equal(data.excluded['Great Energy Beam']!.sources.length, 2);
  assert.deepEqual(
    data.excluded['Great Energy Beam']!.sources.map((s) => s.shape).sort(),
    ['1x7', '1x8'],
  );
  assert.ok(data.spells['Energy Beam'], 'padding-only differences are not a conflict');
  assert.equal(data.spells['Energy Beam']!.affectedTiles, 5);
});

test('stats are recomputed from the file, not copied from the plan', () => {
  const served = Object.keys(data.spells).length;
  const excluded = Object.keys(data.excluded).length;
  assert.equal(data.stats['served'], served);
  assert.equal(data.stats['excluded'], excluded);
  assert.equal(data.stats['served']! + data.stats['excluded']!, data.stats['spells']);

  const corroborated = Object.values(data.spells).filter((e) => e.corroborated).length;
  assert.equal(data.stats['corroborated'], corroborated);
  assert.equal(
    data.stats['corroborated']! + data.stats['familyCorroborated']! + data.stats['uncorroborated']!,
    served,
  );
});

/**
 * The artefact is the only regression oracle this decoder has: there is no external
 * source of truth for player spell areas. Aggregate stats can hold while individual
 * cells drift, so every served mask is compared cell for cell.
 */
test('every served mask still matches the spike measurement', () => {
  const spike = read<{ images: Record<string, { w: number; h: number; mask: number[][] }> }>(
    './fixtures/spell-areas-measured.json',
  );
  const drifted: string[] = [];
  for (const [spell, e] of Object.entries(data.spells)) {
    const measured = spike.images[e.sources[0]!.image];
    assert.ok(measured, `${spell}: no spike mask for ${e.sources[0]!.image}`);
    const want = normaliseMask({ width: measured.w, height: measured.h, cells: measured.mask.flat() });
    if (JSON.stringify(want) !== JSON.stringify({ width: e.width, height: e.height, cells: e.cells })) {
      drifted.push(`${spell} (${e.sources[0]!.image})`);
    }
  }
  assert.deepEqual(drifted, []);
  assert.equal(Object.keys(data.spells).length, 24, 'and all 24 were compared');
});

test('the data file is packaged, or no install can build an index', () => {
  const pkg = read<{ files: string[]; scripts: Record<string, string> }>('../package.json');
  assert.ok(
    pkg.files.includes('data/spell-areas.json'),
    `files is ${JSON.stringify(pkg.files)}; "dist" alone leaves data/ unpublished`,
  );
  assert.ok(pkg.scripts['decode-spell-areas']);
});

test('corroboration is recorded per spell, not inferred', () => {
  // 6 of 24 have a second image of the same spell. The other 18 do not - but 14 of
  // those land on a shape other images independently produce, so `false` must not be
  // read as "no support". src/server.ts instructions carry that distinction.
  const multi = Object.values(data.spells).filter((e) => e.sources.length > 1);
  assert.equal(multi.length, 6);
  assert.ok(multi.every((e) => e.corroborated), 'a second source means corroborated');
  const single = Object.values(data.spells).filter((e) => e.sources.length === 1);
  assert.ok(single.every((e) => !e.corroborated));
  assert.equal(single.length, 18);
});

/**
 * The exclusion rule is this feature's load-bearing safety property, and inspecting
 * an already-correct artefact cannot detect a runner that stopped comparing masks.
 * These drive the decision logic directly, with no network.
 */
test('padding-only differences agree; genuinely different shapes do not', () => {
  const beam = (height: number, from: number): Mask => ({
    width: 3, height,
    cells: Array.from({ length: 3 * height }, (_, i) =>
      (i % 3 === 1 && Math.floor(i / 3) >= from && Math.floor(i / 3) < from + 5 ? 1 : 0)),
  });
  // The real Energy Beam pair: identical 1x5 on canvases of 3x8 and 3x9.
  const agreeing = decideSpell([
    { image: 'a.gif', mask: normaliseMask(beam(8, 1)) },
    { image: 'b.gif', mask: normaliseMask(beam(9, 2)) },
  ]);
  assert.equal(agreeing.kind, 'served');
  assert.equal(agreeing.kind === 'served' && agreeing.corroborated, true);

  // The real Great Energy Beam pair: 1x7 against 1x8.
  const line = (n: number): Mask => ({ width: 1, height: n, cells: new Array(n).fill(1) });
  const disagreeing = decideSpell([
    { image: 'c.gif', mask: line(7) },
    { image: 'd.gif', mask: line(8) },
  ]);
  assert.equal(disagreeing.kind, 'excluded');
  assert.equal(disagreeing.kind === 'excluded' && disagreeing.reason, 'images disagree');
  assert.deepEqual(disagreeing.images, ['c.gif', 'd.gif'], 'both sources are named');
});

test('a single image serves, and is not marked corroborated', () => {
  const one = decideSpell([{ image: 'a.gif', mask: { width: 1, height: 1, cells: [1] } }]);
  assert.equal(one.kind, 'served');
  assert.equal(one.kind === 'served' && one.corroborated, false);
  assert.equal(decideSpell([]).kind, 'excluded', 'no candidates cannot be served');
});

test('the candidate filter admits area images and rejects the rest', () => {
  const tile = (w: number, h: number) => ({ width: w, height: h });
  assert.equal(isAreaCandidate('Avalanche1.gif', tile(288, 288)), true);
  assert.equal(isAreaCandidate('Icon.gif', tile(32, 32)), false, 'one tile is not an area');
  assert.equal(isAreaCandidate('Burned Icon.gif', tile(11, 11)), false, 'not tile-aligned');
  assert.equal(isAreaCandidate('Avatar (Outfit).gif', tile(64, 64)), false, 'outfits are not areas');
  assert.equal(isAreaCandidate('Missing.gif', undefined), false, 'an unsized file is not a candidate');
});
