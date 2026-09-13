import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { resolveDbPath } from '../src/db.ts';
import { buildIndex, GENERATOR, GENERATOR_PYTHON, type Runner } from '../src/indexer/build-index.ts';
import { eligibleScenes, MCP_SCHEMA_VERSION, type EnrichStats } from '../src/indexer/enrich.ts';
import { FIXTURE, tempDirs } from './harness.ts';

const scratch = tempDirs('twmcp-bi-');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** The committed lock, located from here rather than through build-index's own constant. */
const LOCK = fileURLToPath(new URL('../data/tibiawikisql-requirements.txt', import.meta.url));

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

type Subcommand = 'venv' | 'pip install' | 'run';
const isSubcommand = (s: string): s is Subcommand => s === 'venv' || s === 'pip install' || s === 'run';

/**
 * Stands in for uv and records every call. Only `uv run` writes a database: it hands the
 * path after `-o` to `generate`, which copies the fixture there unless a case says
 * otherwise, and whose result, if any, is the call's. `exit` makes a subcommand fail
 * without running anything.
 *
 * Nothing else is written, and that is load-bearing. The `uvx` fakes this replaces copied
 * the fixture to every call's last argument, which for `uv pip install` is the shipped lock.
 */
function fakeUv(opts: {
  exit?: Partial<Record<Subcommand, ReturnType<Runner>>>;
  generate?: (output: string) => ReturnType<Runner> | void;
} = {}) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: Runner = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const subcommand = args[0] === 'pip' ? `pip ${args[1]}` : String(args[0]);
    if (cmd !== 'uv' || !isSubcommand(subcommand)) {
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    }
    const exit = opts.exit?.[subcommand];
    if (exit) return exit;
    const generated = subcommand === 'run'
      ? (opts.generate ?? ((output) => copyFileSync(FIXTURE, output)))(args[args.length - 1]!)
      : undefined;
    return generated ?? { status: 0, stderr: '' };
  };
  return {
    run,
    calls,
    /** The environment directory, as `uv venv` was handed it. */
    env: (): string => {
      const venv = calls.find((c) => c.args[0] === 'venv');
      assert.ok(venv, 'uv venv was never called');
      return venv.args[venv.args.length - 1]!;
    },
  };
}
type FakeUv = ReturnType<typeof fakeUv>;

/** Captures stderr instead of printing it, until `restore` runs. */
function captureStderr() {
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof write;
  return { text: () => written.join(''), restore: () => { process.stderr.write = write; } };
}

/**
 * The committed lock's requirements as pip reads them: a trailing backslash continues a
 * line and `#` starts a comment. Parsed here rather than through build-index, so a
 * miscount there cannot pass by agreeing with itself.
 */
const lockEntries = (): string[] =>
  readFileSync(LOCK, 'utf8').replace(/\\\n/g, ' ').split('\n')
    .map((line) => line.replace(/#.*/, '').trim().replace(/\s+/g, ' '))
    .filter(Boolean);

test('runs uv venv, uv pip install and uv run in that order, then installs atomically', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  const uv = fakeUv();

  const result = await buildIndex({ targetPath: target, enrich: noopEnrich, api, run: uv.run });

  const env = uv.env();
  const output = uv.calls.at(-1)!.args.at(-1)!;
  // Exactly these three: no uvx, which cannot check a hash, and no bin/ or Scripts\ path,
  // which would tie the build to one platform's environment layout.
  assert.deepEqual(uv.calls, [
    { cmd: 'uv', args: ['venv', '--python', GENERATOR_PYTHON, env] },
    { cmd: 'uv', args: ['pip', 'install', '--python', env, '--require-hashes', '--no-build', '-r', LOCK] },
    { cmd: 'uv', args: ['run', '--no-project', '--python', env, 'tibiawikisql', 'generate', '--skip-images', '-o', output] },
  ]);
  assert.equal(dirname(output), dir, 'the temp index must sit beside its target, so the rename stays atomic');
  assert.notEqual(output, target, 'must build to a temp path, not straight to the target');
  assert.equal(result, target);
  assert.ok(existsSync(target), 'temp file should be renamed into place');
  assert.equal(readdirSync(dir).length, 1, 'no temp file left behind');
});

/**
 * In the data repo the target's directory is the checkout root, so an environment built
 * beside the target would land among tracked files. And it is removed as soon as the
 * generator returns, since nothing after that uses it.
 */
test('the generator environment lives under the OS temp directory and is gone before enrichment', async () => {
  const target = join(scratch(), 'tibiawiki.db');
  let whileGenerating: boolean | undefined;
  let atEnrichment: boolean | undefined;
  const uv: FakeUv = fakeUv({
    generate: (output) => {
      whileGenerating = existsSync(uv.env());
      copyFileSync(FIXTURE, output);
    },
  });

  await buildIndex({
    targetPath: target,
    api,
    run: uv.run,
    enrich: async () => {
      atEnrichment = existsSync(uv.env());
      return stats();
    },
  });

  assert.equal(dirname(uv.env()), tmpdir(), 'the environment must be created directly under os.tmpdir()');
  assert.equal(whileGenerating, true, 'the generator runs from a directory build-index created');
  assert.equal(atEnrichment, false, 'the environment must be removed as soon as the generator returns');
  assert.equal(existsSync(uv.env()), false);
});

test('a successful install is reported on stderr with the count of locked requirements', async () => {
  const target = join(scratch(), 'tibiawiki.db');
  // The data repo's weekly build logs this line, so it is matched whole.
  const line = `Generator environment installed from tibiawikisql-requirements.txt with ${lockEntries().length} hashed requirements.\n`;
  let beforeGenerating = '';
  const captured = captureStderr();
  try {
    const uv = fakeUv({
      generate: (output) => {
        beforeGenerating = captured.text();
        copyFileSync(FIXTURE, output);
      },
    });
    await buildIndex({ targetPath: target, enrich: noopEnrich, api, run: uv.run });
  } finally {
    captured.restore();
  }
  assert.equal(beforeGenerating, line, 'written once the install succeeds, and before the generator runs');
  assert.equal(captured.text().split(line).length - 1, 1, 'and never written again');
});

for (const [subcommand, stderr] of [
  ['venv', 'No interpreter found for CPython >=3.10, <3.14 in virtual environments, managed installations, or search path'],
  ['pip install', 'Hash mismatch for `annotated-types==0.8.0`'],
] as const) {
  test(`a failing uv ${subcommand} stops the build before the generator runs`, async () => {
    const dir = scratch();
    const target = join(dir, 'tibiawiki.db');
    copyFileSync(FIXTURE, target);
    const before = sha(target);
    const uv = fakeUv({ exit: { [subcommand]: { status: 2, stderr } } });

    const captured = captureStderr();
    try {
      await assert.rejects(
        buildIndex({ targetPath: target, enrich: noopEnrich, api, run: uv.run }),
        (error: Error) => {
          assert.match(error.message, /^Could not install the generator environment/);
          assert.ok(error.message.includes(stderr), `uv's stderr must be in the error: ${error.message}`);
          return true;
        },
      );
    } finally {
      captured.restore();
    }
    assert.equal(uv.calls.some(({ args }) => args[0] === 'run'), false, 'the generator must not run');
    assert.doesNotMatch(captured.text(), /Generator environment installed/, 'a failed install is not reported as installed');
    assert.equal(existsSync(uv.env()), false, 'the generator environment must be removed');
    assert.equal(sha(target), before, 'the pre-existing index must survive untouched');
    assert.equal(readdirSync(dir).length, 1, 'no temp file left behind');
  });
}

test('a failing generator leaves an existing good index byte-identical', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  copyFileSync(FIXTURE, target);
  const before = sha(target);
  // A crawl that dies part way leaves a partial database behind it.
  const uv = fakeUv({
    generate: (output) => {
      writeFileSync(output, 'partial');
      return { status: 1, stderr: 'boom' };
    },
  });

  await assert.rejects(
    buildIndex({ targetPath: target, enrich: noopEnrich, api, run: uv.run }),
    /boom/,
  );
  assert.equal(sha(target), before, 'the pre-existing index must survive untouched');
  assert.equal(readdirSync(dir).length, 1, 'no temp file left behind');
  assert.equal(existsSync(uv.env()), false, 'the generator environment must be removed');
});

test('a runner that throws still removes the generator environment', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  const uv = fakeUv({
    generate: (output) => {
      writeFileSync(output, 'partial');
      throw new Error('spawnSync uv EACCES');
    },
  });

  await assert.rejects(
    buildIndex({ targetPath: target, enrich: noopEnrich, api, run: uv.run }),
    /EACCES/,
  );
  assert.equal(existsSync(uv.env()), false, 'the generator environment must be removed');
  assert.deepEqual(readdirSync(dir), [], 'no temp file left behind');
});

test('a generator that succeeds but writes nothing is rejected', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  const uv = fakeUv({ generate: () => {} });
  await assert.rejects(
    buildIndex({ targetPath: target, enrich: noopEnrich, api, run: uv.run }),
    /produced no file/,
  );
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(uv.env()), false, 'the generator environment must be removed');
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
      run: fakeUv({ generate: (output) => writeFileSync(output, 'not a sqlite database') }).run,
    }),
    /valid TibiaWiki index|missing required|file is not a database/i,
  );
  assert.equal(sha(target), before, 'exit-zero plus a file is not proof of a usable index');
  assert.equal(readdirSync(dir).length, 1, 'no temp file left behind');
});

test('creates the parent directory when it does not exist', async () => {
  const target = join(scratch(), 'nested', 'deeper', 'tibiawiki.db');
  await buildIndex({ targetPath: target, enrich: noopEnrich, api, run: fakeUv().run });
  assert.ok(existsSync(target));
});

/**
 * The write target must never follow the read resolution, which can land on the
 * packaged index: a fresh install's build would then rename 18 MB into node_modules,
 * where the next install wipes it and a read-only node_modules refuses it outright.
 *
 * Checked in the one state where the two differ: the data package installed and nothing
 * built. buildIndex has no packaged-index seam and must not grow one - that would reopen
 * the very coupling this guards.
 */
test('the default install target is the cache path, never the packaged index', async () => {
  const cache = scratch();
  const expected = join(cache, 'tibiawiki-mcp', 'tibiawiki.db');
  const saved = { override: process.env.TIBIAWIKI_MCP_DB, xdg: process.env.XDG_CACHE_HOME };
  // Unset, not just ignored: a developer's own override would aim this build at their index.
  delete process.env.TIBIAWIKI_MCP_DB;
  process.env.XDG_CACHE_HOME = cache;
  try {
    // Guard: in this state the read resolution names the installed package, so a target
    // that followed it would land there and fail below rather than pass by accident.
    assert.equal(resolveDbPath(), realpathSync(DB_PATH));

    const installed = await buildIndex({
      enrich: noopEnrich,
      api,
      run: fakeUv({
        generate: (output) => {
          // Checked before anything is written. The build generates beside its target, so a
          // regressed target fails here, before its rename could put the fixture over the
          // installed package's index.
          assert.equal(dirname(output), dirname(expected), 'the build is not generating in the cache');
          copyFileSync(FIXTURE, output);
        },
      }).run,
    });
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
    run: fakeUv({ generate: (output) => copyFileSync(bare, output) }).run,
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
      run: fakeUv().run,
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
      run: fakeUv().run,
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
      run: fakeUv().run,
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
      run: fakeUv().run,
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
      run: fakeUv().run,
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
    run: fakeUv().run,
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
      run: fakeUv().run,
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
      run: fakeUv().run,
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
  const uv = fakeUv();

  await assert.rejects(
    buildIndex({
      targetPath: target,
      api,
      enrich: async () => { throw new Error('wiki unreachable'); },
      run: uv.run,
    }),
    /Enrichment failed.*wiki unreachable/s,
  );
  assert.equal(sha(target), before, 'the pre-existing index must survive an enrichment failure');
  assert.equal(readdirSync(dir).length, 1, 'no temp file left behind');
  assert.equal(existsSync(uv.env()), false, 'the generator environment must be removed');
});

test('coverage below the floor fails the build', async () => {
  const dir = scratch();
  const target = join(dir, 'tibiawiki.db');
  await assert.rejects(
    buildIndex({
      targetPath: target,
      api,
      enrich: async () => stats({ scenes: 100, stored: 50, joined: 50 }),
      run: fakeUv().run,
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
      run: fakeUv().run,
    }),
    /no eligible scenes/i,
  );
  assert.equal(existsSync(target), false);
});

/**
 * `uv pip install --require-hashes` is what refuses an unhashed or mismatched entry at
 * build time. These pin the committed lock itself, so a bad refresh fails here first.
 */
test('the generator lock pins every requirement with == and hashes it', () => {
  const entries = lockEntries();
  // tibiawikisql alone would parse too, but it has dependencies, and they must be locked.
  assert.ok(entries.length > 1, `the lock lists ${entries.length} requirement(s)`);
  // An exact version starts with a digit and holds no `*`, so `==0.*` and `===` are refused.
  const pinnedAndHashed =
    /^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9][0-9A-Za-z.!+_-]*(?: ; (?:(?! --hash=).)+)?(?: --hash=sha256:[0-9a-f]{64})+$/;
  assert.deepEqual(entries.filter((entry) => !pinnedAndHashed.test(entry)), []);
});

test('the lock pins the generator build-index runs', () => {
  const generator = lockEntries().filter((entry) => /^tibiawikisql==/i.test(entry));
  assert.equal(generator.length, 1, 'exactly one tibiawikisql entry');
  assert.equal(generator[0]!.split(' ')[0], GENERATOR);
});

test('the lock header records the cutoff, the uv version, the Python range, the checks and the command', () => {
  const header = /^(?:#.*\n)+/.exec(readFileSync(LOCK, 'utf8'))?.[0] ?? '';
  const field = (name: string) => new RegExp(`^# ${name}: (.+)$`, 'm').exec(header)?.[1];
  const cutoff = field('cutoff');
  assert.match(cutoff ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'an absolute cutoff, as re-running needs it');
  assert.match(field('uv') ?? '', /^uv \d+\.\d+\.\d+ /, 'the uv --version output');
  // The lock was checked against this range, so a changed constant needs a regenerated lock.
  assert.equal(field('python'), GENERATOR_PYTHON, 'the lock was generated for another Python range');
  const bounds = /^cpython>=(\d+)\.(\d+),<\d+\.(\d+)$/.exec(GENERATOR_PYTHON);
  assert.ok(bounds, `GENERATOR_PYTHON is not a cpython>=X.Y,<X.Z range: ${GENERATOR_PYTHON}`);
  const major = Number(bounds[1]);
  const floorMinor = Number(bounds[2]);
  // A check dropped from lock-generator would still write a lock, so what it checked is pinned
  // here: every CPython minor version the range admits, on each of lock-generator's five platforms.
  const pythons = Array.from({ length: Number(bounds[3]) - floorMinor }, (_, i) => `${major}.${floorMinor + i}`);
  assert.equal(
    field('checked'),
    `CPython ${pythons.join(', ')} on x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu, ` +
      'x86_64-apple-darwin, aarch64-apple-darwin, x86_64-pc-windows-msvc',
    'the lock was not checked on every CPython the range admits, on every platform',
  );
  // The compile floor comes from the same constant the environment is created with.
  assert.equal(
    field('command'),
    `echo '${GENERATOR}' | uv pip compile - --universal --generate-hashes --no-build ` +
      `--python-version ${major}.${floorMinor} --exclude-newer ${cutoff} --no-header`,
  );
});

test('lock-generator refuses a cutoff that is not an absolute UTC time, before it runs uv', () => {
  const script = fileURLToPath(new URL('../scripts/lock-generator.ts', import.meta.url));
  const before = sha(LOCK);
  // A PATH of one empty directory has no uv on it, so a run that got as far as uv fails
  // on that instead.
  const noUv = scratch();
  // uv reads a bare date in the local time zone and a duration against the clock, so
  // neither names the same instant twice. The third date does not exist, and the fourth
  // parses but is not the one form a cutoff is written in.
  for (const cutoff of ['2026-09-06', '7 days', '2026-02-30T00:00:00Z', '+010000-01-01T00:00Z']) {
    const r = spawnSync(process.execPath, [script, '--cutoff', cutoff], {
      env: { ...process.env, PATH: noUv }, encoding: 'utf8',
    });
    assert.notEqual(r.status, 0, `--cutoff ${cutoff} was accepted`);
    assert.match(r.stderr, /--cutoff must be an absolute UTC time/, `--cutoff ${cutoff}:\n${r.stderr}`);
  }
  assert.equal(sha(LOCK), before, 'a refused run must leave the lock untouched');
});
