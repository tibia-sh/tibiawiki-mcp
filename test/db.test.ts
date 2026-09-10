import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDbPath, openDb, SchemaError } from '../src/db.ts';

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
  full.close();
  db.close();
  assert.throws(() => openDb(bad), (e: unknown) => {
    assert.ok(e instanceof SchemaError);
    assert.match((e as Error).message, /database_info|version/);
    return true;
  });
});
