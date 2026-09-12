import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { buildIndex } from '../src/indexer/build-index.ts';
import { eligibleScenes, MCP_SCHEMA_VERSION, type EnrichStats } from '../src/indexer/enrich.ts';
import { FIXTURE, tempDirs } from './harness.ts';

const scratch = tempDirs('twmcp-bi-');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * Every case injects an enricher. Without one `buildIndex` would call the real
 * pass, which fetches the live wiki; `fetches` proves no test ever does.
 */
let fetches = 0;
const api = { pageWikitext: async () => { fetches += 1; return []; },
              moduleSource: async () => { fetches += 1; return ''; },
              categoryMembers: async () => { fetches += 1; return []; },
              imageInfo: async () => { fetches += 1; return []; } };

/** Per-type image stats that satisfy the build gate: all seven present, all resolved. */
const allTypesResolved = () => Object.fromEntries(
  (['creature', 'item', 'npc', 'spell', 'mount', 'imbuement', 'charm'] as const).map((t) =>
    [t, { subjects: 1, resolved: 1, missing: 0, invalid: 0, skipped: 0 }]),
);

const stats = (over: Partial<EnrichStats> = {}): EnrichStats => ({
  scenes: 10, joined: 10, ambiguous: 0, noRow: 0,
  discardedKind: 0, discardedNoSpell: 0, discardedRotate: 0, unparsedMember: 0,
  patterns: 114, rejectedPatterns: [], stored: 10, danglingKey: 0, pagesNotInIndex: 0,
  missingPages: 0, conflictingKey: 0, images: allTypesResolved(), spellShapes: { served: 24, unmatched: 0, unmatchedTitles: [] },
  ...over,
});
const noopEnrich = async () => stats();

test('invokes the pinned generator with --skip-images and installs atomically', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  let seen: { cmd: string; args: string[] } | undefined;

  const result = await buildIndex({
    targetPath: target,
    enrich: noopEnrich,
    api,
    run: (cmd, args) => {
      seen = { cmd, args };
      // The generator writes to whatever path it was handed.
      copyFileSync(FIXTURE, args[args.length - 1]!);
      return { status: 0, stderr: '' };
    },
  });

  assert.equal(seen!.cmd, 'uvx');
  assert.ok(seen!.args.includes('--skip-images'), 'images must never be fetched');
  assert.ok(seen!.args.includes('tibiawikisql==9.0.0'), 'generator version must be pinned');
  assert.notEqual(seen!.args.at(-1), target, 'must build to a temp path, not straight to the target');
  assert.equal(result, target);
  assert.ok(existsSync(target), 'temp file should be renamed into place');
  assert.equal(readdirSync(dir).length, 1, 'no temp file left behind');
});

test('a failing generator leaves an existing good index byte-identical', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  copyFileSync(FIXTURE, target);
  const before = sha(target);

  await assert.rejects(
    buildIndex({ targetPath: target, enrich: noopEnrich, api, run: () => ({ status: 1, stderr: 'boom' }) }),
    /boom/,
  );
  assert.equal(sha(target), before, 'the pre-existing index must survive untouched');
  assert.equal(readdirSync(dir).length, 1, 'no temp file left behind');
});

test('a generator that succeeds but writes nothing is rejected', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  await assert.rejects(
    buildIndex({ targetPath: target, enrich: noopEnrich, api, run: () => ({ status: 0, stderr: '' }) }),
    /produced no file/,
  );
  assert.equal(existsSync(target), false);
});

test('a generator that writes a schema-invalid file is rejected and the target survives', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  copyFileSync(FIXTURE, target);
  const before = sha(target);

  await assert.rejects(
    buildIndex({
      targetPath: target,
      enrich: noopEnrich,
      api,
      run: (_cmd, args) => {
        writeFileSync(args[args.length - 1]!, 'not a sqlite database');
        return { status: 0, stderr: '' };
      },
    }),
    /valid TibiaWiki index|missing required|file is not a database/i,
  );
  assert.equal(sha(target), before, 'exit-zero plus a file is not proof of a usable index');
  assert.equal(readdirSync(dir).length, 1, 'no temp file left behind');
});

test('creates the parent directory when it does not exist', async () => {
  const target = join(scratch(), 'nested', 'deeper', 'tibiawiki.db');
  await buildIndex({
    targetPath: target,
    enrich: noopEnrich,
    api,
    run: (_cmd, args) => {
      copyFileSync(FIXTURE, args[args.length - 1]!);
      return { status: 0, stderr: '' };
    },
  });
  assert.ok(existsSync(target));
});

/**
 * The write target must never follow the read resolution, which can land on the
 * packaged index: a fresh install's build would then rename 18 MB into node_modules,
 * where the next install wipes it and a read-only node_modules refuses it outright.
 *
 * A regression guard, not a red-green test. buildIndex has no packaged-index seam and
 * must not grow one - that would reopen the very coupling this guards - so while the
 * data package is absent it is the source check that catches a regression. Once the
 * package is installed, the install location check catches it as well.
 */
test('the default install target is the cache path, never the packaged index', async () => {
  // Checked before building: with the package installed, a regressed build would
  // install over the packaged index before the location check below could fail.
  const uses = readFileSync(new URL('../src/indexer/build-index.ts', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => /\bresolveDbPath\b/.test(line));
  assert.deepEqual(uses, [],
    'build-index must not use the read resolution, which can name the packaged index');

  const cache = scratch();
  const saved = { override: process.env.TIBIAWIKI_MCP_DB, xdg: process.env.XDG_CACHE_HOME };
  // Unset, not just ignored: a developer's own override would aim this build at their index.
  delete process.env.TIBIAWIKI_MCP_DB;
  process.env.XDG_CACHE_HOME = cache;
  try {
    const installed = await buildIndex({
      enrich: noopEnrich,
      api,
      run: (_cmd, args) => { copyFileSync(FIXTURE, args[args.length - 1]!); return { status: 0, stderr: '' }; },
    });
    const expected = join(cache, 'tibiawiki-mcp', 'tibiawiki.db');
    assert.equal(installed, expected);
    assert.ok(existsSync(expected), 'the index must be installed in the cache');
  } finally {
    if (saved.override === undefined) delete process.env.TIBIAWIKI_MCP_DB;
    else process.env.TIBIAWIKI_MCP_DB = saved.override;
    if (saved.xdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved.xdg;
  }
});

/**
 * The ordering invariant, which nothing else covers: every other case feeds an
 * already-enriched fixture as generator output, so validation would pass whether it
 * ran before or after enrichment. Real generator output has no mcp_* tables, so a
 * validate-first order rejects the build's own fresh index. This case reproduces
 * that by handing over an index stripped of them and letting the enricher add them.
 */
test('enrichment runs before validation, not after', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  const bare = join(dir, 'bare.db');
  copyFileSync(FIXTURE, bare);
  const strip = new DatabaseSync(bare);
  strip.exec('drop table mcp_ability_area; drop table mcp_area_pattern; drop table mcp_schema_version; drop table mcp_image; drop table mcp_spell_area');
  strip.close();

  await buildIndex({
    targetPath: target,
    api,
    // Stands in for the real pass: it is what puts the tables there.
    enrich: async (dbPath) => {
      const db = new DatabaseSync(dbPath);
      db.exec(`create table mcp_area_pattern (key text primary key, width integer not null, cells text not null);
               create table mcp_ability_area (creature_id integer not null, ability_name text not null,
                 ability_effect text not null default '', ability_element text not null default '',
                 pattern_key text not null references mcp_area_pattern(key), effect_on_caster integer not null,
                 primary key (creature_id, ability_name, ability_effect, ability_element));
               create table mcp_schema_version (version integer not null);
               create table mcp_spell_area (article_id integer not null primary key,
                 width integer not null, height integer not null, cells text not null,
                 source_image text not null, source_url text not null, corroborated integer not null);
               create table mcp_image (entity_type text not null, article_id integer not null,
                 file_name text not null, url text not null, description_url text not null,
                 width integer not null, height integer not null, mime_type text not null,
                 primary key (entity_type, article_id));
               insert into mcp_area_pattern values ('8sqmwave', 9, '[0]');
               insert into mcp_schema_version values (${MCP_SCHEMA_VERSION});`);
      db.close();
      return stats();
    },
    run: (_cmd, args) => { copyFileSync(bare, args[args.length - 1]!); return { status: 0, stderr: '' }; },
  });
  assert.ok(existsSync(target), 'generate -> enrich -> validate must succeed on bare output');
});

test('a partial page fetch fails the build rather than reporting full coverage', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  await assert.rejects(
    buildIndex({
      targetPath: target,
      api,
      // Every scene it did see joined, so coverage alone reads as a perfect run.
      enrich: async () => stats({ missingPages: 3 }),
      run: (_cmd, args) => { copyFileSync(FIXTURE, args[args.length - 1]!); return { status: 0, stderr: '' }; },
    }),
    /returned no content|partial fetch/i,
  );
  assert.equal(existsSync(target), false);
});

test('a surge of unrecognised member openers fails the build', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  // Coverage still reads as a flawless 100%: these scenes left both the numerator
  // and the denominator, which is exactly why the ratio alone cannot catch it.
  const surge = stats({ scenes: 100, unparsedMember: 40, joined: 60, stored: 60 });
  assert.equal(eligibleScenes(surge), 60);
  assert.equal(surge.stored / eligibleScenes(surge), 1);

  await assert.rejects(
    buildIndex({
      targetPath: target,
      api,
      enrich: async () => surge,
      run: (_cmd, args) => { copyFileSync(FIXTURE, args[args.length - 1]!); return { status: 0, stderr: '' }; },
    }),
    /unrecognised member opener/i,
  );
  assert.equal(existsSync(target), false);
});

const imageStats = (over: Record<string, unknown> = {}) => ({
  ...allTypesResolved(), ...over,
});

test('a type that resolves no images fails the build, naming it', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  await assert.rejects(
    buildIndex({
      targetPath: target, api,
      enrich: async () => stats({ images: imageStats({
        charm: { subjects: 24, resolved: 0, missing: 24, invalid: 0, skipped: 0 },
      }) }),
      run: (_cmd, args) => { copyFileSync(FIXTURE, args[args.length - 1]!); return { status: 0, stderr: '' }; },
    }),
    /charm.*0\.0%.*below the 95% floor/s,
  );
  assert.equal(existsSync(target), false);
});

test('a type that was never requested fails the build', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  // The corpus-wide rate cannot see this: with no charm entry, every present type
  // still reads 100%.
  const withoutCharm = imageStats();
  delete (withoutCharm as Record<string, unknown>)['charm'];
  await assert.rejects(
    buildIndex({
      targetPath: target, api,
      enrich: async () => stats({ images: withoutCharm }),
      run: (_cmd, args) => { copyFileSync(FIXTURE, args[args.length - 1]!); return { status: 0, stderr: '' }; },
    }),
    /no subjects for "charm"/,
  );
  assert.equal(existsSync(target), false, 'a failed gate must not install');
});

test('an unusable image response fails the build even at full coverage', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  await assert.rejects(
    buildIndex({
      targetPath: target, api,
      enrich: async () => stats({ images: imageStats({
        item: { subjects: 100, resolved: 100, missing: 0, invalid: 4, skipped: 0 },
      }) }),
      run: (_cmd, args) => { copyFileSync(FIXTURE, args[args.length - 1]!); return { status: 0, stderr: '' }; },
    }),
    /item.*4 unusable/s,
  );
  assert.equal(existsSync(target), false, 'a failed gate must not install');
});

test('missing images alone do not fail the build', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  // 209/211 is the real spell rate; a wiki gap must not block a release.
  await buildIndex({
    targetPath: target, api,
    enrich: async () => stats({ images: imageStats({
      spell: { subjects: 211, resolved: 209, missing: 2, invalid: 0, skipped: 0 },
    }) }),
    run: (_cmd, args) => { copyFileSync(FIXTURE, args[args.length - 1]!); return { status: 0, stderr: '' }; },
  });
  assert.ok(existsSync(target));
});

test('an unmatched spell area key warns by name without bricking the build', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  const written: string[] = [];
  const stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string) => { written.push(String(c)); return true; }) as typeof stderr;
  try {
    await buildIndex({
      targetPath: target, api,
      enrich: async () => stats({ spellShapes: { served: 23, unmatched: 1, unmatchedTitles: ['Mass Heal'] } }),
      run: (_cmd, args) => { copyFileSync(FIXTURE, args[args.length - 1]!); return { status: 0, stderr: '' }; },
    });
  } finally {
    process.stderr.write = stderr;
  }
  // A wiki rename must not stop every user building an index over one derived shape.
  assert.ok(existsSync(target), 'the index still installs');

  // Isolate the WARNING. buildIndex also writes formatStats to stderr, and that
  // block now lists the titles too - so matching /Mass Heal/ over all of stderr
  // passes even if the warning degrades to a bare count. Proven by mutation.
  const warning = written.join('').split('\n').find((l) => l.startsWith('warning:')) ?? '';
  assert.ok(warning, 'a warning line must be emitted');
  assert.match(warning, /spell area key/);
  assert.match(warning, /Mass Heal/, 'the warning itself names the key, not just the stats block');
});

test('too few spell area shapes fails the build', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  // A missing or truncated data file, not a wiki gap: these are committed data.
  await assert.rejects(
    buildIndex({
      targetPath: target, api,
      enrich: async () => stats({ spellShapes: { served: 3, unmatched: 0, unmatchedTitles: [] } }),
      run: (_cmd, args) => { copyFileSync(FIXTURE, args[args.length - 1]!); return { status: 0, stderr: '' }; },
    }),
    /below the floor of 20/,
  );
  assert.equal(existsSync(target), false);
});

test('no build-index case reaches the network', () => {
  assert.equal(fetches, 0, 'an uninjected enricher would fetch the live wiki');
});

test('a failing enricher leaves an existing good index byte-identical', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  copyFileSync(FIXTURE, target);
  const before = sha(target);

  await assert.rejects(
    buildIndex({
      targetPath: target,
      api,
      enrich: async () => { throw new Error('wiki unreachable'); },
      run: (_cmd, args) => { copyFileSync(FIXTURE, args[args.length - 1]!); return { status: 0, stderr: '' }; },
    }),
    /Enrichment failed.*wiki unreachable/s,
  );
  assert.equal(sha(target), before, 'the pre-existing index must survive an enrichment failure');
  assert.equal(readdirSync(dir).length, 1, 'no temp file left behind');
});

test('coverage below the floor fails the build', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  await assert.rejects(
    buildIndex({
      targetPath: target,
      api,
      enrich: async () => stats({ scenes: 100, stored: 50, joined: 50 }),
      run: (_cmd, args) => { copyFileSync(FIXTURE, args[args.length - 1]!); return { status: 0, stderr: '' }; },
    }),
    /coverage 50\.0% is below the 95% floor/i,
  );
  assert.equal(existsSync(target), false, 'a low-coverage index must not be installed');
});

test('zero eligible scenes fails rather than passing on NaN', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  // 0/0 is NaN, and `NaN < 0.95` is false: a naive comparison would pass here.
  await assert.rejects(
    buildIndex({
      targetPath: target,
      api,
      enrich: async () => stats({ scenes: 0, joined: 0, stored: 0 }),
      run: (_cmd, args) => { copyFileSync(FIXTURE, args[args.length - 1]!); return { status: 0, stderr: '' }; },
    }),
    /no eligible scenes/i,
  );
  assert.equal(existsSync(target), false);
});
