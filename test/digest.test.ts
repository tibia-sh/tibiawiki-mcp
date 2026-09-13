import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, REQUIRED_COLUMNS } from '../src/db.ts';
import { indexDigest } from '../src/indexer/digest.ts';
import { FIXTURE, tempDirs } from './harness.ts';

/**
 * `index-digest` is how the data repo's weekly drift job tells new wiki content from the
 * same content with fresh stamps. A digest that moves when nothing changed opens a pull
 * request every week until everyone ignores it. One that holds still when something did
 * change lets the published index age silently.
 */

const dir = tempDirs('twmcp-digest-')();
let files = 0;

/** A scratch copy of `base`, changed through its own writable handle. */
function variant(base: string, change: (db: DatabaseSync) => void): string {
  const path = join(dir, `index-${files++}.db`);
  copyFileSync(base, path);
  // Off, so a test can empty or reshape any table without first unpicking every
  // reference into it. The digest never reads the constraints.
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  try {
    change(db);
  } finally {
    db.close();
  }
  return path;
}

const TABLES = Object.keys(REQUIRED_COLUMNS);

/**
 * The fixture cut to one row per covered table. It still passes every schema check, and
 * digesting it takes a few milliseconds instead of tens, so the tests that need a digest
 * per case can afford one. database_info keeps all of its rows, since the probe requires
 * two of its keys.
 */
const SMALL = variant(FIXTURE, (db) => {
  for (const table of TABLES) {
    if (table === 'database_info') continue;
    db.exec(`delete from "${table}" where rowid <> (select min(rowid) from "${table}")`);
  }
  db.exec('vacuum');
});

/**
 * `base` rebuilt row for row in a UTF-16 database. The encoding is fixed when a file's first
 * table is created, and SQLite will not attach databases of different encodings, so the
 * rows are copied between two handles.
 */
function inUtf16(base: string): string {
  const path = join(dir, `index-${files++}.db`);
  const source = new DatabaseSync(base, { readOnly: true });
  const target = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  try {
    target.exec("pragma encoding = 'UTF-16le'");
    target.exec('begin');
    const tables = source.prepare("select name, sql from sqlite_master where type = 'table' and name not like 'sqlite_%'").all();
    for (const { name, sql } of tables) {
      target.exec(String(sql));
      const columns = source.prepare(`pragma table_info("${String(name)}")`).all().map((column) => `"${String(column['name'])}"`);
      const read = source.prepare(`select ${columns.join(', ')} from "${String(name)}"`);
      read.setReadBigInts(true);
      const insert = target.prepare(`insert into "${String(name)}" (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`);
      for (const row of read.iterate()) insert.run(...Object.values(row));
    }
    target.exec('commit');
    assert.equal(target.prepare('pragma encoding').get()?.['encoding'], 'UTF-16le');
  } finally {
    source.close();
    target.close();
  }
  return path;
}

/** Asserts that a write touched exactly one row, so a typo cannot make a test vacuous. */
function changesOne(db: DatabaseSync, sql: string): void {
  assert.equal(db.prepare(sql).run().changes, 1, `expected one row changed by: ${sql}`);
}

/**
 * database_info is the generator's stamp table, and on two real builds four of its five
 * keys changed with no content change: `timestamp` and `generate_time` on every run,
 * `python_version` and `platform` between a macOS and a Linux host. Only `version`, the
 * generator's own version, is content.
 */
test('a rebuild on another day and another host digests the same', () => {
  const restamped = variant(FIXTURE, (db) => {
    changesOne(db, "update database_info set value = '1799999999.123456' where key = 'timestamp'");
    changesOne(db, "update database_info set value = '2027-01-15T04:05:06.123456+00:00' where key = 'generate_time'");
    changesOne(db, "update database_info set value = '3.14.2' where key = 'python_version'");
    changesOne(db, "update database_info set value = 'Linux-6.11.0-1018-azure-x86_64-with-glibc2.39' where key = 'platform'");
  });
  assert.equal(indexDigest(restamped), indexDigest(FIXTURE));
});

test('a database_info key a future generator adds does not move the digest', () => {
  // The four stamps above are only the ones known today. Coverage is an allowlist, so
  // the next stamp stays out too instead of opening a drift PR the week it appears.
  const extended = variant(FIXTURE, (db) => {
    changesOne(db, "insert into database_info (key, value) values ('build_id', 'gh-run-4242')");
  });
  assert.equal(indexDigest(extended), indexDigest(FIXTURE));
});

test("a key that is 'version' only under its column's collation does not move the digest", () => {
  // openDb checks database_info's column names, not their collation. Under NOCASE, a
  // `key = 'version'` filter would also pick up this row, and a stamp could ride in it.
  const shadowed = variant(SMALL, (db) => {
    db.exec(`
      create table info (key text collate nocase not null, value text);
      insert into info select key, value from database_info;
      drop table database_info;
      alter table info rename to database_info;
    `);
    changesOne(db, "insert into database_info (key, value) values ('VERSION', '2027-01-15T04:05:06')");
  });
  assert.equal(indexDigest(shadowed), indexDigest(SMALL));
});

test('a different generator version moves the digest', () => {
  // The generator decides which rows the wiki becomes, so its version is content.
  const regenerated = variant(FIXTURE, (db) => {
    changesOne(db, "update database_info set value = '9.0.1' where key = 'version'");
  });
  assert.notEqual(indexDigest(regenerated), indexDigest(FIXTURE));
});

test('changing one covered value moves the digest', () => {
  const changed = variant(FIXTURE, (db) => {
    changesOne(db, "update creature set hitpoints = hitpoints + 1 where title = 'Dragon'");
  });
  assert.notEqual(indexDigest(changed), indexDigest(FIXTURE));
});

test('adding a covered row moves the digest', () => {
  const added = variant(FIXTURE, (db) => {
    changesOne(db, "insert into creature_sound (creature_id, content) select article_id, 'ROOOAAAR!' from creature where title = 'Dragon'");
  });
  assert.notEqual(indexDigest(added), indexDigest(FIXTURE));
});

test('a change outside the covered columns and tables does not move the digest', () => {
  const touched = variant(FIXTURE, (db) => {
    // Neither column is in REQUIRED_COLUMNS, and no tool reads the map table.
    changesOne(db, "update creature set plural = 'dragonz', timestamp = '2099-01-01T00:00:00+00:00' where title = 'Dragon'");
    changesOne(db, "insert into map (z, image) values (7, x'00ff')");
  });
  assert.equal(indexDigest(touched), indexDigest(FIXTURE));
});

test('removing a row from any covered table moves the digest', () => {
  const base = indexDigest(SMALL);
  for (const table of TABLES) {
    // mcp_schema_version cannot lose its one row and still open, and database_info's
    // single covered row is what the allowlist tests above are about.
    if (table === 'mcp_schema_version' || table === 'database_info') continue;
    const emptied = variant(SMALL, (db) => changesOne(db, `delete from "${table}"`));
    assert.notEqual(indexDigest(emptied), base, `${table} does not reach the digest`);
  }
});

test('the same content stored in the opposite order digests the same', () => {
  const stored = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare('select item_id, name, value from item_attribute order by rowid').all();
    } finally {
      db.close();
    }
  };
  const reversed = variant(FIXTURE, (db) => {
    for (const table of TABLES) {
      db.exec(`
        create temp table reinserted as select * from "${table}" order by rowid desc;
        delete from "${table}";
        insert into "${table}" select * from reinserted order by rowid;
        drop table reinserted;
      `);
    }
  });
  // Re-reading one file proves nothing about storage order, so first prove it moved.
  // item_attribute has no primary key, so its rows really are stored in insertion order.
  assert.notDeepEqual(stored(reversed), stored(FIXTURE), 'the rewrite did not change the stored order');
  assert.equal(indexDigest(reversed), indexDigest(FIXTURE));
});

test('the same content in a UTF-16 database digests the same', () => {
  // The tools read text as strings, whatever the file's encoding, but SQLite stores and
  // compares it in that encoding: 'a' sorts before U+0100 in UTF-8 and after it in UTF-16LE.
  const utf8 = variant(SMALL, (db) => {
    db.exec('delete from item_attribute');
    const insert = db.prepare('insert into item_attribute (item_id, name, value) values (1, ?, ?)');
    insert.run('a', 'v');
    insert.run(String.fromCharCode(0x100), 'v');
  });
  assert.equal(indexDigest(inUtf16(utf8)), indexDigest(utf8));
});

/**
 * SQLite's own comparison ties rows whose content differs: text that differs only in case
 * under a NOCASE column, an integer and a real of equal value, and the two zeros. An order
 * that leans on that comparison leaves each pair to storage order, so whichever row is
 * stored first, the pair must digest the same. The current schema cannot produce these,
 * but the probe checks column names only, so a generator change could.
 */
for (const [label, ddl, first, second] of [
  ['text equal only under NOCASE', 'item_id integer, name text collate nocase, value text', "(1, 'a', 'v')", "(1, 'A', 'v')"],
  ['an integer and a real of equal value', 'item_id, name, value', "(1, 'n', 1)", "(1, 'n', 1.0)"],
  ['negative and positive zero', 'item_id, name, value', "(1, 'n', -0.0)", "(1, 'n', 0.0)"],
] as const) {
  test(`rows that tie in SQLite's order digest the same in either stored order: ${label}`, () => {
    const stored = (a: string, b: string) => variant(SMALL, (db) => {
      db.exec(`drop table item_attribute; create table item_attribute (${ddl}); insert into item_attribute values ${a}, ${b};`);
    });
    assert.equal(indexDigest(stored(first, second)), indexDigest(stored(second, first)));
  });
}

test('NULL, integer, real, text and blob never share a digest', () => {
  // A column with no declared type keeps every value in the storage class it was written
  // in. The empty values share a zero-length payload, and 1, 1.0, '1' and x'31' are the
  // collisions of reading every number as a JS number or every value as its text. The
  // last two are 2^53 and 2^53 + 1, which no JS number can tell apart.
  const cases = [
    ['null', 'null'], ['1', 'integer'], ['1.0', 'real'], ["'1'", 'text'],
    ["x'31'", 'blob'], ["''", 'text'], ["x''", 'blob'],
    ['9007199254740992', 'integer'], ['9007199254740993', 'integer'],
  ] as const;
  const digests = cases.map(([literal, storageClass]) => indexDigest(variant(SMALL, (db) => {
    db.exec(`drop table item_attribute; create table item_attribute (item_id, name, value); insert into item_attribute values (1, 'n', ${literal});`);
    assert.equal(db.prepare('select typeof(value) as t from item_attribute').get()?.['t'], storageClass);
  })));
  for (const [i, a] of digests.entries()) {
    for (const [j, b] of digests.entries()) {
      if (i < j) assert.notEqual(a, b, `${cases[i]![0]} and ${cases[j]![0]} share a digest`);
    }
  }
});

/**
 * Moves characters across a value boundary, inside a row and between two rows, and needs
 * the digest to move with them. With no separator this is plain concatenation; the rest
 * are every C0 control character and the printable characters encodings delimit with.
 * Each pair is its own comparison: in one shared database, a collision in one row would
 * hide behind the other rows' differences.
 */
const SEPARATORS = ['', ...Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)), ' ', ',', ';', ':', '|', '"', '\\'];

test('text moved across a value boundary moves the digest', () => {
  // item_attribute's name and value are adjacent text columns.
  const withinRow = (name: string, value: string) => indexDigest(variant(SMALL, (db) => {
    db.exec('delete from item_attribute');
    db.prepare('insert into item_attribute (item_id, name, value) values (1, ?, ?)').run(name, value);
  }));
  // mcp_area_pattern's covered columns start and end with text and it sorts by `key`
  // first, so the cells of the 'a' row are followed directly by the next row's key.
  const acrossRows = (cells: string, key: string) => indexDigest(variant(SMALL, (db) => {
    db.exec('delete from mcp_area_pattern');
    const insert = db.prepare('insert into mcp_area_pattern (key, width, cells) values (?, 1, ?)');
    insert.run('a', cells);
    insert.run(key, '[1]');
  }));
  for (const sep of SEPARATORS) {
    const shown = JSON.stringify(sep);
    assert.notEqual(withinRow(`a${sep}b`, 'c'), withinRow('a', `b${sep}c`), `a column boundary with ${shown}`);
    assert.notEqual(acrossRows(`x${sep}y`, 'z'), acrossRows('x', `y${sep}z`), `a row boundary with ${shown}`);
  }
});

test('a row moved to the next table of the same shape moves the digest', () => {
  // Only the row count separates one table's rows from the next table's, and this move
  // sits exactly on that boundary: the rows in digest order are identical either way.
  assert.equal(TABLES.indexOf('npc_race'), TABLES.indexOf('npc_job') + 1, 'npc_job and npc_race must be adjacent');
  assert.deepEqual(REQUIRED_COLUMNS['npc_race'], REQUIRED_COLUMNS['npc_job'], 'npc_job and npc_race must share a shape');
  const split = (jobs: number) => indexDigest(variant(SMALL, (db) => {
    db.exec('delete from npc_job; delete from npc_race');
    const rows = [[1, 'a'], [2, 'b'], [3, 'c']] as const;
    for (const [i, [npc, name]] of rows.entries()) {
      db.prepare(`insert into ${i < jobs ? 'npc_job' : 'npc_race'} (npc_id, name) values (?, ?)`).run(npc, name);
    }
  }));
  assert.notEqual(split(2), split(1));
});

/** The built binary, spawned the way stdio.test.ts spawns it. */
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['dist/index.js', ...args], { cwd: process.cwd(), encoding: 'utf8' });

const USAGE = /Usage: tibiawiki-mcp .*index-digest <path>/;

// Only stdout is asserted whole. Node 22, which engines allows, writes an ExperimentalWarning
// for node:sqlite to stderr, so stderr is searched for what this CLI writes, never matched
// in full.
test('index-digest prints the digest and a newline, and nothing else', () => {
  const run = cli('index-digest', SMALL);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^[0-9a-f]{64}\n$/);
  assert.equal(run.stdout, `${indexDigest(SMALL)}\n`);
});

for (const [label, args] of [
  ['no path', []],
  ['an empty path', ['']],
  ['two paths', [SMALL, SMALL]],
] as const) {
  test(`index-digest given ${label} prints usage and exits 2`, () => {
    const run = cli('index-digest', ...args);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, USAGE);
  });
}

test('an unknown command still exits 2, with a usage that lists index-digest', () => {
  const run = cli('digest-index');
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Unknown command: digest-index/);
  assert.match(run.stderr, USAGE);
});

/**
 * The drift job digests an index it has just built. One the server would refuse must fail
 * the job loudly, with the reason the server itself gives, rather than print a digest.
 */
for (const [label, make] of [
  ['an index the schema probe refuses', () => variant(SMALL, (db) => db.exec('drop table mcp_spell_area'))],
  ['a file that is not a database', () => {
    const path = join(dir, `junk-${files++}.db`);
    writeFileSync(path, 'not a database');
    return path;
  }],
  ['a path with no file', () => join(dir, 'absent.db')],
] as const) {
  test(`index-digest exits 1 with the server's reason on ${label}`, () => {
    const path = make();
    let reason = '';
    assert.throws(() => openDb(path), (error: unknown) => {
      reason = (error as Error).message;
      return true;
    });
    const run = cli('index-digest', path);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.split('\n').includes(`tibiawiki-mcp: ${reason}`), `stderr was: ${run.stderr}`);
  });
}
