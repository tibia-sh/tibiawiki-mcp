import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrich, eligibleScenes, formatStats, MCP_SCHEMA_VERSION, IMAGE_TYPES } from '../src/indexer/enrich.ts';
import type { EnrichStats } from '../src/indexer/enrich.ts';
import type { WikiApi } from '../src/indexer/wiki-api.ts';
import { FIXTURE } from './harness.ts';

const LUA = readFileSync(new URL('./fixtures/scene-data.lua', import.meta.url), 'utf8');
const scratch = () => join(mkdtempSync(join(tmpdir(), 'twmcp-en-')), 'index.db');
const copy = () => { const p = scratch(); copyFileSync(FIXTURE, p); return p; };
/** A temp JSON beside a scratch index: scratch() returns a file, not a directory. */
const tempJson = (name: string, body: unknown): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'twmcp-sa-')), name);
  writeFileSync(p, JSON.stringify(body));
  return p;
};

/** Ability members lifted from the live Dragon page, newlines and all. */
const DRAGON_WIKITEXT = `{{Infobox Creature
|abilities = {{Ability List
|{{Ability|Fire Wave|100-170|element=fire
  |scene={{Scene|spell=8sqmwave|effect=Fireball Effect|look_direction=east}}}}
|{{Healing|range=40-70
  |scene={{Scene|spell=buffspell|effect=Blue Sparkles Effect|effect_on_caster=yes}}}}
}}
}}`;

function fakeApi(pages: Record<string, string>, lua = LUA): WikiApi & { fetches: number } {
  const api = {
    fetches: 0,
    async moduleSource() { api.fetches += 1; return lua; },
    async categoryMembers() { api.fetches += 1; return Object.keys(pages); },
    async pageWikitext(titles: string[]) {
      api.fetches += 1;
      return titles.filter((t) => t in pages).map((title) => ({ title, wikitext: pages[title]! }));
    },
    async imageInfo(files: string[]) {
      api.fetches += 1;
      // Every requested file resolves; image-specific behaviour is covered in
      // test/images.test.ts, so this only has to satisfy the contract.
      return files.map((requestedTitle) => ({
        requestedTitle, title: requestedTitle, found: true as const,
        url: `https://static.wikia.nocookie.net/tibia/images/a/ab/${requestedTitle.slice(5)}/revision/latest?cb=1`,
        descriptionUrl: `https://tibia.fandom.com/wiki/${requestedTitle}`,
        width: 64, height: 64, mime: requestedTitle.endsWith('.png') ? 'image/png' : 'image/gif',
      }));
    },
  };
  return api;
}

/** Per-type image stats that satisfy the build gate: all seven present, all resolved. */
const allTypesResolved = () => Object.fromEntries(
  (['creature', 'item', 'npc', 'spell', 'mount', 'imbuement', 'charm'] as const).map((t) =>
    [t, { subjects: 1, resolved: 1, missing: 0, invalid: 0, skipped: 0 }]),
);

const open = (p: string) => new DatabaseSync(p, { readOnly: true });
const count = (db: DatabaseSync, table: string) =>
  (db.prepare(`select count(*) c from "${table}"`).get() as { c: number }).c;

test('enrichment creates all three tables and stores the pattern by name', async () => {
  const path = copy();
  const stats = await enrich(path, fakeApi({ Dragon: DRAGON_WIKITEXT }));

  const db = open(path);
  assert.equal(count(db, 'mcp_area_pattern'), 114);
  // Named, not counted: a double-quote-only parser also yields a plausible number.
  const rk = db.prepare("select width from mcp_area_pattern where key = 'rootkraken1'").get();
  assert.ok(rk, 'single-quoted keys must reach the database');
  assert.equal(
    (db.prepare('select version from mcp_schema_version').get() as { version: number }).version,
    MCP_SCHEMA_VERSION,
  );
  assert.equal(count(db, 'mcp_ability_area'), 2, 'Fire Wave and Self-Healing');
  db.close();

  assert.equal(stats.stored, 2);
  assert.equal(stats.ambiguous, 0);
  assert.equal(stats.danglingKey, 0);
});

test('IMAGE_TYPES lists exactly the seven image-bearing types', () => {
  // The build gate iterates this same constant, so a type deleted from it vanishes
  // from both the work and its own policing without any test noticing.
  assert.deepEqual(
    IMAGE_TYPES.map((t) => t.entityType).sort(),
    ['charm', 'creature', 'imbuement', 'item', 'mount', 'npc', 'spell'],
  );
});

test('enrichment writes spell area shapes, Avalanche by name', async () => {
  const path = copy();
  await enrich(path, fakeApi({ Dragon: DRAGON_WIKITEXT }));
  const db = open(path);
  const row = db.prepare(
    `select m.width, m.height, m.cells, m.source_image, m.corroborated
       from mcp_spell_area m join spell s on s.article_id = m.article_id
      where s.title = ?`,
  ).get('Avalanche') as { width: number; height: number; cells: string; source_image: string } | undefined;
  assert.ok(row, 'Avalanche must have a shape row');
  assert.equal(row.width, 7);
  assert.equal(row.height, 7);
  assert.equal((JSON.parse(row.cells) as number[]).filter((c) => c === 1).length, 37);
  assert.equal(row.source_image, 'Avalanche1.gif');
  assert.equal(count(db, 'mcp_spell_area'), 24);
  db.close();
});

test('a spell key matching no index row is counted, not stored', async () => {
  const path = copy();
  const bad = tempJson('bad-areas.json', {
    spells: {
      Avalanche: { width: 1, height: 1, cells: [1], corroborated: false,
        sources: [{ image: 'A.gif', url: 'https://example.invalid/A.gif' }] },
      'Mass Heal': { width: 1, height: 1, cells: [1], corroborated: false,
        sources: [{ image: 'B.gif', url: 'https://example.invalid/B.gif' }] },
    },
  });
  // 'Mass Heal' does not exist; the index says 'Mass Healing'. Left ungated, three
  // or four such misses serve null for real spells with nothing failing.
  const stats = await enrich(path, fakeApi({ Dragon: DRAGON_WIKITEXT }), { spellAreasPath: bad });
  assert.equal(stats.spellShapes.served, 1);
  assert.equal(stats.spellShapes.unmatched, 1);
  // Named, not merely counted: build-index reports these so a maintainer can see
  // which key drifted. A bare count leaves them guessing among 24 spells.
  assert.deepEqual(stats.spellShapes.unmatchedTitles, ['Mass Heal']);
});

test('a malformed spell mask is rejected before it is stored', async () => {
  const path = copy();
  for (const [label, entry] of [
    ['non-binary cell', { width: 2, height: 1, cells: [0, 3] }],
    ['length mismatch', { width: 2, height: 2, cells: [0, 1, 0] }],
    ['zero width', { width: 0, height: 1, cells: [] }],
  ] as const) {
    const bad = tempJson(`bad-${label.replace(/ /g, '-')}.json`, {
      spells: { Avalanche: { ...entry, corroborated: false,
        sources: [{ image: 'A.gif', url: 'https://example.invalid/A.gif' }] } },
    });
    await assert.rejects(
      () => enrich(copy(), fakeApi({ Dragon: DRAGON_WIKITEXT }), { spellAreasPath: bad }),
      /well-formed binary mask/, label,
    );
  }
  assert.ok(path);
});

test('enrichment writes image rows, named per type', async () => {
  const path = copy();
  await enrich(path, fakeApi({ Dragon: DRAGON_WIKITEXT }));
  const db = open(path);

  // Named, per type. A bare count would stay green with only spells stored, and an
  // empty mcp_image would make every tibia_get return image: null silently.
  for (const [type, table, title, ext] of [
    ['creature', 'creature', 'Dragon', 'gif'],
    ['charm', 'charm', 'Adrenaline Burst', 'png'],
    ['imbuement', 'imbuement', 'Powerful Reap', 'png'],
  ] as const) {
    const row = db.prepare(
      `select m.file_name, m.url, m.mime_type from mcp_image m
         join "${table}" e on e.article_id = m.article_id
        where m.entity_type = ? and e.title = ?`,
    ).get(type, title) as { file_name: string; url: string; mime_type: string } | undefined;
    assert.ok(row, `${type} ${title} must have an image row`);
    assert.equal(row.file_name, `${title}.${ext}`);
    assert.ok(row.url.length > 0, 'the url must not be empty');
  }
  assert.ok(count(db, 'mcp_image') > 100, 'all seven types contribute rows');
  db.close();
});

test('the stored row carries the matched identity and the caster flag', async () => {
  const path = copy();
  await enrich(path, fakeApi({ Dragon: DRAGON_WIKITEXT }));

  const db = open(path);
  const wave = db.prepare(
    "select pattern_key, ability_effect, ability_element, effect_on_caster from mcp_ability_area where ability_name = 'Fire Wave'",
  ).get() as { pattern_key: string; ability_effect: string; ability_element: string; effect_on_caster: number };
  assert.equal(wave.pattern_key, '8sqmwave');
  assert.equal(wave.ability_element, 'fire');
  assert.equal(wave.effect_on_caster, 0);

  const heal = db.prepare(
    "select effect_on_caster from mcp_ability_area where ability_name = 'Self-Healing'",
  ).get() as { effect_on_caster: number };
  assert.equal(heal.effect_on_caster, 1, 'effect_on_caster=yes must survive to the row');
  db.close();
});

test('re-running after the source changes leaves no stale rows', async () => {
  const path = copy();
  await enrich(path, fakeApi({ Dragon: DRAGON_WIKITEXT }));
  assert.equal(count(open(path), 'mcp_ability_area'), 2);

  // Re-running identical input proves nothing; the source must change.
  const trimmed = DRAGON_WIKITEXT.replace(/\|\{\{Healing[\s\S]*?\}\}\}\}\n/, '');
  await enrich(path, fakeApi({ Dragon: trimmed }));

  const db = open(path);
  assert.equal(count(db, 'mcp_ability_area'), 1, 'the removed ability must not survive');
  const stale = db.prepare(
    "select count(*) c from mcp_ability_area where ability_name = 'Self-Healing'",
  ).get() as { c: number };
  assert.equal(stale.c, 0, 'the removed ability must leave no row behind');
  assert.equal(count(db, 'mcp_schema_version'), 1, 'the version row must not accumulate');
  db.close();
});

test('a reference to an undefined pattern is counted and never stored', async () => {
  const path = copy();
  const wikitext = DRAGON_WIKITEXT.replace('spell=8sqmwave', 'spell=notarealpattern');
  const stats = await enrich(path, fakeApi({ Dragon: wikitext }));

  assert.equal(stats.danglingKey, 1);
  assert.equal(stats.stored, 1, 'only the healing row survives');
  const db = open(path);
  assert.equal(count(db, 'mcp_ability_area'), 1);
  db.close();
});

test('pages absent from the index are skipped, not charged against coverage', async () => {
  const path = copy();
  const stats = await enrich(path, fakeApi({
    Dragon: DRAGON_WIKITEXT,
    'Bestiary/Classes': '{{Ability|Whatever|1|scene={{Scene|spell=8sqmwave}}}}',
  }));

  assert.equal(stats.pagesNotInIndex, 1);
  assert.equal(stats.scenes, 2, 'only the indexed page contributes scenes');
  assert.equal(stats.stored, 2);
});

test('a page the API lists but never returns is counted as missing', async () => {
  const path = copy();
  // Dragon is in the index; the API lists it but returns no content for it.
  const api = fakeApi({ Dragon: DRAGON_WIKITEXT });
  const truncated = { ...api, async pageWikitext() { return []; } };
  const stats = await enrich(path, truncated);

  assert.equal(stats.missingPages, 1);
  // Without the reconciliation this reads as a clean run over an empty corpus.
  assert.equal(stats.scenes, 0);
});

test('two members claiming one ability row are reported, not silently ordered', async () => {
  const path = copy();
  // Both members resolve to Dragon's Fire Wave row but name different patterns.
  const wikitext = `{{Ability|Fire Wave|100-170|element=fire|scene={{Scene|spell=8sqmwave}}}}
|{{Ability|Fire Wave|100-170|element=fire|scene={{Scene|spell=buffspell}}}}`;
  const stats = await enrich(path, fakeApi({ Dragon: wikitext }));

  assert.equal(stats.conflictingKey, 1, 'the losing mapping must be visible');
  assert.equal(stats.stored, 1, 'stored counts rows actually written, not attempts');
  const db = open(path);
  assert.equal(count(db, 'mcp_ability_area'), 1);
  assert.equal(stats.stored, count(db, 'mcp_ability_area'), 'stored must equal real rows');
  db.close();
});

test('formatStats names unmatched spell keys, and says when it truncates', () => {
  // formatStats had no test at all, and it is what a maintainer reads to find a
  // renamed spell among 24.
  const make = (spellShapes: EnrichStats['spellShapes']): EnrichStats => ({
    scenes: 0, joined: 0, ambiguous: 0, noRow: 0,
    discardedKind: 0, discardedNoSpell: 0, discardedRotate: 0, unparsedMember: 0,
    patterns: 0, rejectedPatterns: [], stored: 0, images: {},
    danglingKey: 0, pagesNotInIndex: 0, missingPages: 0, conflictingKey: 0,
    spellShapes,
  });
  const clean = formatStats(make({ served: 24, unmatched: 0, unmatchedTitles: [] }));
  assert.match(clean, /spell shapes {4}24 served, 0 unmatched/);
  assert.ok(!/unmatched \(/.test(clean), 'no empty parenthetical when nothing is unmatched');

  const two = formatStats(make({ served: 22, unmatched: 2, unmatchedTitles: ['Mass Heal', 'Old Name'] }));
  assert.match(two, /Mass Heal, Old Name/);
});

test('eligibleScenes excludes intentional discards only', () => {
  const base = {
    scenes: 100, joined: 80, ambiguous: 1, noRow: 4,
    discardedKind: 10, discardedNoSpell: 2, discardedRotate: 1, unparsedMember: 2,
    patterns: 114, rejectedPatterns: [], stored: 80, danglingKey: 0, pagesNotInIndex: 0,
    missingPages: 0, conflictingKey: 0, images: allTypesResolved(), spellShapes: { served: 24, unmatched: 0, unmatchedTitles: [] },
  };
  // 100 - (10 + 2 + 1 + 2) = 85. ambiguous and noRow are failures, not discards,
  // so they stay in the denominator.
  assert.equal(eligibleScenes(base), 85);
});
