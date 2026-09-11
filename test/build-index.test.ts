import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from '../src/indexer/build-index.ts';
import { eligibleScenes, type EnrichStats } from '../src/indexer/enrich.ts';
import { FIXTURE } from './harness.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'twmcp-bi-'));
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * Every case injects an enricher. Without one `buildIndex` would call the real
 * pass, which fetches the live wiki; `fetches` proves no test ever does.
 */
let fetches = 0;
const api = { pageWikitext: async () => { fetches += 1; return []; },
              moduleSource: async () => { fetches += 1; return ''; },
              categoryMembers: async () => { fetches += 1; return []; } };

const stats = (over: Partial<EnrichStats> = {}): EnrichStats => ({
  scenes: 10, joined: 10, ambiguous: 0, noRow: 0,
  discardedKind: 0, discardedNoSpell: 0, discardedRotate: 0, unparsedMember: 0,
  patterns: 114, rejectedPatterns: [], stored: 10, danglingKey: 0, pagesNotInIndex: 0,
  missingPages: 0, conflictingKey: 0,
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
  strip.exec('drop table mcp_ability_area; drop table mcp_area_pattern; drop table mcp_schema_version');
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
               insert into mcp_area_pattern values ('8sqmwave', 9, '[0]');
               insert into mcp_schema_version values (1);`);
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
