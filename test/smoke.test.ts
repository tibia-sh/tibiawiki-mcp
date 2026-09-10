import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

test('toolchain: node:sqlite is available in the standard library', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('create table t (x integer)');
  db.prepare('insert into t values (?)').run(42);
  const row = db.prepare('select x from t').get() as { x: number };
  assert.equal(row.x, 42);
  db.close();
});
