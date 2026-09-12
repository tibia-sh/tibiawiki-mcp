import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';

type Shape = {
  width: number; height: number; cells: number[]; ascii: string;
  affectedTiles: number; derivedFrom: string;
  sourceImage: string; sourceUrl: string; corroborated: boolean;
} | null;
type Handle = Awaited<ReturnType<typeof connect>>;

const withServer = async <T>(fn: (h: Handle) => Promise<T>): Promise<T> => {
  const h = await connect();
  try { return await fn(h); } finally { await h.close(); }
};

const structured = async (h: Handle, name: string): Promise<Record<string, unknown>> => {
  const res = await h.client.callTool({ name: 'tibia_get', arguments: { name } });
  assert.notEqual(res.isError, true, `${name}: ${JSON.stringify(res.content)}`);
  return (res as { structuredContent: Record<string, unknown> }).structuredContent;
};
const shapeOf = async (h: Handle, name: string): Promise<Shape> =>
  ((await structured(h, name)) as { areaShape?: Shape }).areaShape ?? null;

const AVALANCHE = [
  '. . # # # . .',
  '. # # # # # .',
  '# # # # # # #',
  '# # # # # # #',
  '# # # # # # #',
  '. # # # # # .',
  '. . # # # . .',
].join('\n');

test('Avalanche returns its 37-tile circle', async () => withServer(async (h) => {
  const shape = await shapeOf(h, 'Avalanche');
  assert.ok(shape, 'Avalanche must carry a shape');
  assert.equal(shape.width, 7);
  assert.equal(shape.height, 7);
  assert.equal(shape.affectedTiles, 37);
  assert.equal(shape.ascii, AVALANCHE);
  assert.equal(shape.derivedFrom, 'animation');
  assert.equal(shape.sourceImage, 'Avalanche1.gif');
  assert.match(shape.sourceUrl, /^https:\/\/static\.wikia\.nocookie\.net\//);
}));

/**
 * Both halves of the draft-1 measurement error. Great Energy Beam's two images
 * genuinely disagree (1x7 vs 1x8) so it is excluded; Energy Beam's do not - they
 * differ only in canvas padding - and calling that a conflict cost a plan round.
 */
test('a conflicting spell serves nothing; a padding-only difference serves a shape',
  async () => withServer(async (h) => {
    assert.equal(await shapeOf(h, 'Great Energy Beam'), null, 'images disagree: serve nothing');
    const beam = await shapeOf(h, 'Energy Beam');
    assert.ok(beam, 'padding alone is not a disagreement');
    assert.equal(beam.affectedTiles, 5);
  }));

test('a spell with no decoded animation returns null', async () => withServer(async (h) => {
  assert.equal(await shapeOf(h, 'Light Healing'), null);
}));

test('Fire Wave is a cone, not its bounding box', async () => withServer(async (h) => {
  // The shape the original classifier bug got wrong: it read as a filled rectangle.
  const shape = await shapeOf(h, 'Fire Wave');
  assert.ok(shape);
  assert.equal(shape.affectedTiles, 12);
  assert.equal(shape.ascii, ['. . # . .', '. # # # .', '. # # # .', '# # # # #'].join('\n'));
}));

/**
 * The two kinds of knowledge must stay separable. A creature ability's `area` is the
 * wiki's own labelled tile data with caster and target glyphs; a spell's `areaShape`
 * is a binary mask decoded from a picture. A refactor that merged them would let an
 * agent read a guess as a fact.
 */
test('a creature ability area and a spell areaShape are structurally distinct',
  async () => withServer(async (h) => {
    const dragon = await structured(h, 'Dragon') as {
      areaShape?: unknown;
      abilities: Array<{ name: string; area: { ascii: string; key?: string; effectOnCaster?: boolean } | null }>;
    };
    assert.equal(dragon.areaShape, undefined, 'a creature has no areaShape');

    const wave = dragon.abilities.find((a) => a.name === 'Fire Wave');
    assert.ok(wave?.area, 'Dragon Fire Wave carries the wiki grid');
    assert.equal(wave.area.key, '8sqmwave', 'ability areas name a wiki pattern');
    assert.equal(typeof wave.area.effectOnCaster, 'boolean');
    assert.ok(/[@*]/.test(wave.area.ascii), 'ability grids carry caster/target glyphs');

    const spell = await shapeOf(h, 'Avalanche');
    assert.ok(spell);
    assert.equal((spell as unknown as { key?: string }).key, undefined, 'no wiki pattern key');
    assert.equal(
      (spell as unknown as { effectOnCaster?: boolean }).effectOnCaster, undefined,
      'the decode cannot establish a caster tile',
    );
    assert.ok(!/[@*]/.test(spell.ascii), 'spell shapes use only # and .');
    assert.equal(spell.derivedFrom, 'animation');
  }));

test('corroboration is served per spell', async () => withServer(async (h) => {
  // Fire Wave has two images that agree; Avalanche has one.
  assert.equal((await shapeOf(h, 'Fire Wave'))!.corroborated, true);
  assert.equal((await shapeOf(h, 'Avalanche'))!.corroborated, false);
}));

test('the instructions explain the derivation and its limits', async () => withServer(async (h) => {
  const instructions = h.client.getInstructions?.() ?? '';
  assert.match(instructions, /areaShape/);
  assert.match(instructions, /DERIVED by decoding/i);
  assert.match(instructions, /does not distinguish the caster or target/i);
  assert.match(instructions, /not caster-relative/i);
  // `corroborated: false` is true of 18 of 24, but only 4 are wholly unsupported.
  assert.match(instructions, /corroborated means a second image/i);
  assert.match(instructions, /does not mean unsupported/i);
}));

test('tools/list stays within its budget', async () => withServer(async (h) => {
  const { tools } = await h.client.listTools();
  const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  assert.ok(bytes < 30_000, `tools/list is ${bytes} bytes`);
  assert.equal(tools.length, 5);
}));
