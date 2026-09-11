import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from '../src/indexer/build-index.ts';
import type { EnrichStats } from '../src/indexer/enrich.ts';
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
