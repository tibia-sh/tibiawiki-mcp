import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';

type Image = {
  url: string; descriptionUrl: string; width: number; height: number; mimeType: string;
} | null;
type Handle = Awaited<ReturnType<typeof connect>>;

const withServer = async <T>(fn: (h: Handle) => Promise<T>): Promise<T> => {
  const h = await connect();
  try { return await fn(h); } finally { await h.close(); }
};

const get = async (h: Handle, name: string, opts: Record<string, unknown> = {}) => {
  const res = await h.client.callTool({ name: 'tibia_get', arguments: { name, ...opts } });
  assert.notEqual(res.isError, true, `${name}: ${JSON.stringify(res.content)}`);
  return res as { structuredContent: Record<string, unknown>; content: Array<Record<string, unknown>> };
};
const imageOf = async (h: Handle, name: string, opts = {}): Promise<Image> =>
  ((await get(h, name, opts)).structuredContent as { image?: Image }).image ?? null;

test('a creature returns a fetchable url and its description page', async () => withServer(async (h) => {
  const img = await imageOf(h, 'Dragon');
  assert.ok(img, 'Dragon must carry an image');
  assert.match(img.url, /^https:\/\/static\.wikia\.nocookie\.net\//);
  assert.match(img.descriptionUrl, /^https:\/\/tibia\.fandom\.com\/wiki\/File:/);
  assert.equal(img.mimeType, 'image/gif');
  assert.ok(img.width > 0 && img.height > 0);
}));

/**
 * The draft-1 regression. Charms resolve 0/24 under `.gif` and 24/24 under `.png`,
 * and every anchor in that draft was a `.gif` type, so all 24 would have returned
 * null with nothing failing.
 */
test('charms and imbuements resolve as png', async () => withServer(async (h) => {
  for (const name of ['Adrenaline Burst', 'Bless']) {
    const img = await imageOf(h, name);
    assert.ok(img, `charm ${name} must carry an image`);
    assert.equal(img.mimeType, 'image/png', `charm ${name} is a png, not a gif`);
  }
  const imb = await imageOf(h, 'Powerful Reap');
  assert.ok(imb, 'imbuement must carry an image');
  assert.equal(imb.mimeType, 'image/png');
}));

test('every image-bearing type resolves, not only creatures', async () => withServer(async (h) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['Steel Helmet', {}],        // item
    ['Rashid', {}],              // npc
    ['Animate Dead', {}],        // spell
    ['Racing Bird', {}],         // mount
  ];
  for (const [name, opts] of cases) {
    const img = await imageOf(h, name, opts);
    assert.ok(img, `${name} must carry an image`);
    assert.match(img.url, /^https:\/\/static\.wikia\.nocookie\.net\//);
  }
}));

test('an entity with no image returns null and emits no resource_link', async () => withServer(async (h) => {
  // Rejuvenation is one of only two image-less spells, and is ts-only, so the
  // default status filter would otherwise hide it entirely.
  const res = await get(h, 'Rejuvenation', { include_inactive: true });
  assert.equal((res.structuredContent as { image?: Image }).image, null);
  assert.ok(
    !res.content.some((c) => c['type'] === 'resource_link'),
    'no image means no link, rather than a link to nothing',
  );
}));

test('a resolved image also travels as a resource_link for the human', async () => withServer(async (h) => {
  const res = await get(h, 'Dragon');
  const link = res.content.find((c) => c['type'] === 'resource_link');
  assert.ok(link, 'a resolved image must produce a resource_link');
  assert.equal(link['uri'], (res.structuredContent as { image: Image }).image!.url);
  assert.equal(link['mimeType'], 'image/gif');
  assert.ok(String(link['name']).length > 0, 'resource_link requires a name');
  assert.deepEqual((link['annotations'] as { audience: string[] }).audience, ['user']);
}));

/**
 * The identity-corruption regression. Fetching the image by join would collide on
 * `article_id`, and on a miss the later duplicate wins, so `row.article_id` becomes
 * NULL and every child query silently returns nothing. It must be the image-LESS
 * case: a successful match overwrites nothing, so a creature that has an image
 * cannot detect it.
 */
test('an entity without an image keeps all of its child data', async () => withServer(async (h) => {
  const res = await get(h, 'Rejuvenation', { include_inactive: true });
  const spell = res.structuredContent as { image?: Image; title?: string; words?: string | null };
  assert.equal(spell.image, null, 'this must be the image-less case, or it proves nothing');
  assert.equal(spell.title, 'Rejuvenation');
  assert.ok(spell.words !== undefined, 'its own columns must survive');

  // And a creature keeps its children alongside a resolved image.
  const dragon = (await get(h, 'Dragon')).structuredContent as {
    loot?: unknown[]; abilities?: unknown[]; image?: Image;
  };
  assert.ok(dragon.image, 'Dragon has an image');
  assert.ok((dragon.loot ?? []).length > 0, 'loot must survive the image lookup');
  assert.ok((dragon.abilities ?? []).length > 0, 'abilities must survive the image lookup');
}));

test('the instructions state that images are linked, not redistributed', async () => withServer(async (h) => {
  const instructions = h.client.getInstructions?.() ?? '';
  // src/server.ts already mentioned image copyright before this feature, so a
  // /image/ match would pass against unmodified code. Assert the NEW clause.
  assert.match(instructions, /linked from TibiaWiki/i);
  assert.match(instructions, /not stored or redistributed/i);
  assert.match(instructions, /descriptionUrl/i);
}));

test('image dimensions are never described as a tile footprint', async () => withServer(async (h) => {
  const { tools } = await h.client.listTools();
  const get = tools.find((t) => t.name === 'tibia_get');
  assert.ok(get);
  const json = JSON.stringify(get);
  assert.ok(!/tile footprint/i.test(json));
  assert.ok(!/size in tiles/i.test(json));
}));
