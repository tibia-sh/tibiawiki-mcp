import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageExtension, resolveImages, type Subject } from '../src/indexer/images.ts';
import type { ImageInfoOutcome, WikiApi } from '../src/indexer/wiki-api.ts';
import type { EntityType } from '../src/domain.ts';

const CDN = 'https://static.wikia.nocookie.net/tibia/images/a/ab';
const WIKI = 'https://tibia.fandom.com/wiki';

type Override = Partial<Extract<ImageInfoOutcome, { found: true }>>;

/** Answers every requested file, with per-file overrides for the invalid cases. */
function fakeApi(opts: { missing?: string[]; override?: Record<string, Override> } = {}): WikiApi {
  const missing = new Set(opts.missing ?? []);
  return {
    pageWikitext: async () => [],
    moduleSource: async () => '',
    categoryMembers: async () => [],
    async imageInfo(files) {
      return files.map((requestedTitle): ImageInfoOutcome => {
        if (missing.has(requestedTitle)) return { requestedTitle, title: requestedTitle, found: false };
        const name = requestedTitle.slice(5);
        return {
          requestedTitle, title: requestedTitle, found: true,
          url: `${CDN}/${name}/revision/latest?cb=1`,
          descriptionUrl: `${WIKI}/${requestedTitle}`,
          width: 64, height: 64,
          mime: name.endsWith('.png') ? 'image/png' : 'image/gif',
          ...(opts.override?.[requestedTitle] ?? {}),
        };
      });
    },
  };
}

const subject = (entityType: EntityType, articleId: number, title: string): Subject =>
  ({ entityType, articleId, title });

test('the extension is per entity type, and an unknown type throws', () => {
  // Charms resolve 0/24 under .gif and 24/24 under .png; imbuements 9/72 and 72/72.
  // A silent default is exactly how that would have shipped as image: null.
  assert.equal(imageExtension('charm'), 'png');
  assert.equal(imageExtension('imbuement'), 'png');
  for (const t of ['creature', 'item', 'npc', 'spell', 'mount'] as const) {
    assert.equal(imageExtension(t), 'gif');
  }
  assert.throws(() => imageExtension('quest' as EntityType), /quest/);
});

test('a charm is requested as .png, not .gif', async () => {
  const asked: string[] = [];
  const api = fakeApi();
  const spy: WikiApi = { ...api, imageInfo: (f) => { asked.push(...f); return api.imageInfo(f); } };
  await resolveImages([subject('charm', 1, 'Carnage')], spy);
  assert.deepEqual(asked, ['File:Carnage.png']);
});

test('every image field comes back verbatim from the API', async () => {
  const { refs } = await resolveImages([subject('creature', 42, 'Dragon')], fakeApi());
  assert.equal(refs.length, 1);
  const ref = refs[0]!;
  assert.equal(ref.url, `${CDN}/Dragon.gif/revision/latest?cb=1`, 'query string included');
  assert.equal(ref.descriptionUrl, `${WIKI}/File:Dragon.gif`);
  assert.equal(ref.fileName, 'Dragon.gif', 'no File: prefix');
  assert.equal(ref.entityType, 'creature');
  assert.equal(ref.articleId, 42);
  assert.equal(ref.mimeType, 'image/gif');
});

test('an API-confirmed missing file is counted and yields no row', async () => {
  const { refs, stats } = await resolveImages(
    [subject('spell', 1, 'Rejuvenation'), subject('spell', 2, 'Exura')],
    fakeApi({ missing: ['File:Rejuvenation.gif'] }),
  );
  assert.equal(refs.length, 1, 'no fabricated URL for the missing one');
  assert.equal(refs[0]!.articleId, 2);
  assert.equal(stats.spell?.missing, 1);
  assert.equal(stats.spell?.resolved, 1);
  assert.equal(stats.spell?.invalid, 0);
});

test('an unusable response is invalid, not missing', async () => {
  const cases: Array<[string, Override]> = [
    ['non-image mime', { mime: 'text/html' }],
    ['zero width', { width: 0 }],
    ['fractional width', { width: 63.5 }],
    ['off-host url', { url: 'https://evil.example.com/x.gif' }],
    ['non-https url', { url: 'http://static.wikia.nocookie.net/x.gif' }],
    ['off-host descriptionUrl', { descriptionUrl: 'https://evil.example.com/wiki/File:X.gif' }],
  ];
  for (const [label, override] of cases) {
    const { refs, stats } = await resolveImages(
      [subject('creature', 1, 'Dragon')],
      fakeApi({ override: { 'File:Dragon.gif': override } }),
    );
    assert.equal(refs.length, 0, `${label}: must not be stored`);
    assert.equal(stats.creature?.invalid, 1, `${label}: must count as invalid`);
    assert.equal(stats.creature?.missing, 0, `${label}: is a broken response, not a wiki gap`);
  }
});

test('counters are per type and pinned to that type’s input count', async () => {
  const subjects = [
    subject('creature', 1, 'Dragon'), subject('creature', 2, 'Demon'),
    subject('charm', 3, 'Carnage'),
    subject('item', 4, 'Sword'),
  ];
  const { stats } = await resolveImages(subjects, fakeApi({ missing: ['File:Demon.gif'] }));

  assert.equal(stats.creature?.subjects, 2, 'pinned to inputs, not derived from outcomes');
  assert.equal(stats.charm?.subjects, 1);
  assert.equal(stats.item?.subjects, 1);
  assert.equal(stats.spell, undefined, 'a type with no subjects gets no entry');

  for (const [type, s] of Object.entries(stats)) {
    assert.equal(
      s!.resolved + s!.missing + s!.invalid + s!.skipped, s!.subjects,
      `${type}: outcomes must account for every subject`,
    );
  }
});

test('a title containing a pipe is skipped rather than splitting the batch', async () => {
  // Defensive: 0 of 13,799 titles contain a pipe today. The client joins on '|',
  // so one such title would silently become two requests.
  const { refs, stats } = await resolveImages([subject('item', 1, 'Odd|Name')], fakeApi());
  assert.equal(refs.length, 0);
  assert.equal(stats.item?.skipped, 1);
  assert.equal(stats.item?.subjects, 1);
});

test('subjects of different types resolve independently in one pass', async () => {
  const { refs } = await resolveImages([
    subject('creature', 1, 'Dragon'),
    subject('charm', 2, 'Carnage'),
    subject('imbuement', 3, 'Powerful Reap'),
  ], fakeApi());
  const byType = new Map(refs.map((r) => [r.entityType, r]));
  assert.equal(byType.get('creature')?.mimeType, 'image/gif');
  assert.equal(byType.get('charm')?.mimeType, 'image/png');
  assert.equal(byType.get('imbuement')?.mimeType, 'image/png');
});
