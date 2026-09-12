import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDbPath, openDb, SchemaError, MCP_SCHEMA_VERSION } from '../src/db.ts';

const FIXTURE = new URL('./fixtures/tibiawiki-fixture.db', import.meta.url).pathname;
const scratch = () => mkdtempSync(join(tmpdir(), 'twmcp-'));

test('resolveDbPath prefers the explicit env override', () => {
  assert.equal(
    resolveDbPath({ TIBIAWIKI_MCP_DB: '/tmp/x.db' } as NodeJS.ProcessEnv),
    '/tmp/x.db',
  );
});

test('resolveDbPath falls back to the cache directory', () => {
  assert.equal(
    resolveDbPath({ HOME: '/home/u' } as NodeJS.ProcessEnv),
    '/home/u/.cache/tibiawiki-mcp/tibiawiki.db',
  );
});

test('resolveDbPath honours XDG_CACHE_HOME over HOME', () => {
  assert.equal(
    resolveDbPath({ HOME: '/home/u', XDG_CACHE_HOME: '/xdg' } as NodeJS.ProcessEnv),
    '/xdg/tibiawiki-mcp/tibiawiki.db',
  );
});

test('openDb exposes provenance from the database_info key/value table', () => {
  const h = openDb(FIXTURE);
  assert.equal(h.provenance.version, '9.0.0');
  assert.match(h.provenance.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  h.close();
});

test('openDb points the user at build-index when the file is missing', () => {
  assert.throws(() => openDb(join(scratch(), 'absent.db')), /build-index/);
});

test('openDb names the exact missing column when the schema has drifted', () => {
  const bad = join(scratch(), 'bad.db');
  const db = new DatabaseSync(bad);
  db.exec('create table creature (article_id integer)');
  db.close();
  assert.throws(
    () => openDb(bad),
    (e: unknown) => {
      assert.ok(e instanceof SchemaError, `expected SchemaError, got ${String(e)}`);
      assert.match((e as Error).message, /hitpoints/);
      return true;
    },
  );
});

test('openDb validates database_info by KEY, not by column', () => {
  // database_info is a key/value table; a probe that only checked columns would
  // pass this database even though the provenance rows it needs are absent.
  const bad = join(scratch(), 'nokeys.db');
  const db = new DatabaseSync(bad);
  const full = new DatabaseSync(FIXTURE, { readOnly: true });
  for (const r of full.prepare(
    "select sql from sqlite_master where type='table' and name not like 'sqlite_%'",
  ).all()) {
    db.exec(String((r as { sql: string }).sql));
  }
  // A schema-only clone has mcp_schema_version present but empty, which the
  // enrichment probe rejects first. Satisfy it so this test reaches the check it
  // is actually about; without this row the assertion below passes on the wrong
  // error and database_info stops being guarded at all.
  // MCP_SCHEMA_VERSION, not a literal: a stale literal makes this test fail at the
  // version check before reaching the database_info check it is actually about.
  db.exec(`insert into mcp_schema_version (version) values (${MCP_SCHEMA_VERSION})`);
  full.close();
  db.close();
  assert.throws(() => openDb(bad), (e: unknown) => {
    assert.ok(e instanceof SchemaError);
    assert.match((e as Error).message, /database_info/);
    return true;
  });
});

test('openDb rejects an index that has no mcp_spell_area table', () => {
  const bad = join(scratch(), 'noshapes.db');
  copyFileSync(FIXTURE, bad);
  const db = new DatabaseSync(bad);
  db.exec('drop table mcp_spell_area');
  db.close();
  assert.throws(() => openDb(bad), (e: unknown) => {
    assert.ok(e instanceof SchemaError);
    // Named specifically: every SchemaError ends with the same build-index remedy,
    // so matching that alone passes on any other probe failure.
    assert.match((e as Error).message, /mcp_spell_area/);
    assert.match((e as Error).message, /tibiawiki-mcp build-index/);
    return true;
  });
});

test('openDb rejects an index that has no mcp_image table', () => {
  const bad = join(scratch(), 'noimages.db');
  copyFileSync(FIXTURE, bad);
  const db = new DatabaseSync(bad);
  db.exec('drop table mcp_image');
  db.close();
  assert.throws(() => openDb(bad), (e: unknown) => {
    assert.ok(e instanceof SchemaError);
    // Named specifically: every SchemaError in src/db.ts ends with the same
    // "Rebuild with `tibiawiki-mcp build-index`" remedy, so matching that alone
    // passes on any other probe failure.
    assert.match((e as Error).message, /mcp_image/);
    assert.match((e as Error).message, /tibiawiki-mcp build-index/);
    return true;
  });
});

/**
 * The enrichment tables are versioned separately from the generator's schema, so a
 * future reshape becomes a loud rebuild rather than a silent misread: a v1 runtime
 * opening a v2 index would parse `cells` under the wrong shape and serve wrong
 * grids as authoritative. Every branch is asserted, and each must name the remedy.
 */
for (const [label, setup, expected] of [
  ['absent', 'delete from mcp_schema_version', /holds 0 rows/],
  ['duplicated', `insert into mcp_schema_version (version) values (${MCP_SCHEMA_VERSION})`, /holds 2 rows/],
  ['newer than supported', 'update mcp_schema_version set version = 99', /newer than/],
  ['older than supported', 'update mcp_schema_version set version = 1', /older than/],
  // Anchored on this branch's own wording. A loose alternation would also match the
  // mismatch branch's "version NaN, older than..." message, which is how a targeted
  // check becomes deletable without any test noticing.
  ['non-integer', "update mcp_schema_version set version = 'banana'", /non-integer/],
] as const) {
  test(`openDb rejects an enrichment version that is ${label}`, () => {
    const bad = join(scratch(), 'badversion.db');
    copyFileSync(FIXTURE, bad);
    const db = new DatabaseSync(bad);
    db.exec(setup);
    db.close();
    assert.throws(() => openDb(bad), (e: unknown) => {
      assert.ok(e instanceof SchemaError, `expected SchemaError, got ${String(e)}`);
      assert.match((e as Error).message, expected);
      assert.match((e as Error).message, /tibiawiki-mcp build-index/,
        'the message must name the remedy, as every other probe error does');
      return true;
    });
  });
}

/**
 * The probe existed to reject an incompatible index, but was narrower than what the
 * tools actually read: removing charm.cost_level_2 passed and returned
 * costs: [100, null, 225]; removing item_proficiency_perk.skill_image passed and
 * then crashed at tool registration. This asserts the probe covers every column a
 * tool reads, by dropping each one in turn.
 */
test('the probe rejects an index missing any column a tool reads', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['charm', 'cost_level_2'],
    ['item_proficiency_perk', 'skill_image'],
    ['house', 'rent'],
    ['creature_max_damage', 'lifedrain'],
    ['item_key', 'notes'],
    ['world', 'battleye'],
    ['game_update', 'changes'],
  ];
  for (const [table, column] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'twmcp-probe-'));
    const path = join(dir, 'partial.db');
    const db = new DatabaseSync(path);
    const src = new DatabaseSync(FIXTURE, { readOnly: true });
    for (const r of src.prepare(
      "select sql, name from sqlite_master where type='table' and name not like 'sqlite_%'",
    ).all()) {
      let sql = String((r as { sql: string }).sql);
      if (String((r as { name: string }).name) === table) {
        // The DDL is one line of comma-separated definitions, so drop the column by
        // splitting that list rather than by filtering lines.
        const open = sql.indexOf('(');
        const head = sql.slice(0, open + 1);
        const body = sql.slice(open + 1, sql.lastIndexOf(')'));
        const kept = body
          .split(/,(?![^(]*\))/)
          .filter((part) => !new RegExp(`^\\s*"?${column}"?\\s`).test(part));
        sql = `${head}${kept.join(',')})`;
      }
      try { db.exec(sql); } catch { /* a dependent FK may fail; the probe still runs */ }
    }
    src.close();
    db.exec("insert into database_info (key, value) values ('version','9.0.0'), ('generate_time','x')");
    db.close();
    assert.throws(() => openDb(path), (e: unknown) => {
      assert.ok(e instanceof SchemaError, `${table}.${column}: expected SchemaError, got ${String(e)}`);
      assert.match((e as Error).message, new RegExp(column), `${table}.${column} not named in the error`);
      return true;
    }, `dropping ${table}.${column} should be rejected`);
  }
});
