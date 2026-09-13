import { createHash } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import { openDb, REQUIRED_COLUMNS } from '../db.ts';

/**
 * Of database_info, only this key's row is content: the generator version, which decides
 * what rows the wiki becomes. The other keys stamp the run (`timestamp`, `generate_time`)
 * or the build host (`python_version`, `platform`). An allowlist, because a denylist has
 * to know every stamp in advance, and the next one a generator adds would open a drift PR
 * every week.
 */
const COVERED_INFO_KEY = 'version';

/** SQLite's own type codes, from sqlite3.h. */
const INTEGER = 1;
const REAL = 2;
const TEXT = 3;
const BLOB = 4;
const NULL = 5;

/**
 * SHA-256, as lowercase hex, over the content the tools read: every table in
 * REQUIRED_COLUMNS, restricted to those columns, with database_info cut to its version
 * row. The data repo's drift job compares it across a rebuild. The index is opened with
 * openDb, so one the server would refuse throws the server's own error instead.
 *
 * A value is encoded as its storage class (1 byte), its payload length (4 bytes) and the
 * payload: an integer's two's complement or a real's IEEE 754 (8 bytes each), text as
 * UTF-8, a blob as-is, nothing for NULL. Numbers are big-endian. A row is its covered
 * values in declared sequence. Each table contributes its row count (8 bytes), then its
 * rows sorted by their encoding. The count frames tables, the length frames values, and
 * the class tells equal payloads apart (NULL, '' and x'' are all empty).
 *
 * Sorting the encoded rows orders them by the covered columns in declared sequence without
 * leaning on anything SQLite decides: not storage order, not a key, not a column's
 * collation, and not the file's text encoding, which SQLite stores and compares text in.
 */
export function indexDigest(path: string): string {
  const { db, close } = openDb(path);
  try {
    const hash = createHash('sha256');
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      // BINARY, so a column declared NOCASE cannot let a 'VERSION' row in as well.
      const where = table === 'database_info' ? ` where "key" = '${COVERED_INFO_KEY}' collate binary` : '';
      const read = db.prepare(`select ${columns.map((column) => `"${column}"`).join(', ')} from "${table}"${where}`);
      // As BigInt, each JS type node:sqlite returns is exactly one storage class. As a JS
      // number, an integer would look like a real, and past Number.MAX_SAFE_INTEGER throw.
      read.setReadBigInts(true);
      const rows: Buffer[] = [];
      for (const row of read.iterate()) {
        rows.push(Buffer.concat(columns.flatMap((column) => encode(row[column]))));
      }
      rows.sort(Buffer.compare);
      const count = Buffer.alloc(8);
      count.writeBigUInt64BE(BigInt(rows.length));
      hash.update(count);
      for (const row of rows) hash.update(row);
    }
    return hash.digest('hex');
  } finally {
    close();
  }
}

/** A value's header and payload, as two chunks. */
function encode(value: SQLOutputValue | undefined): [Buffer, Uint8Array] {
  if (value === null) return frame(NULL, new Uint8Array(0));
  if (typeof value === 'string') return frame(TEXT, Buffer.from(value, 'utf8'));
  if (value instanceof Uint8Array) return frame(BLOB, value);
  const payload = Buffer.alloc(8);
  if (typeof value === 'bigint') {
    payload.writeBigInt64BE(value);
    return frame(INTEGER, payload);
  }
  if (typeof value === 'number') {
    payload.writeDoubleBE(value);
    return frame(REAL, payload);
  }
  throw new Error(`Unexpected ${typeof value} value in the digest read`);
}

function frame(storageClass: number, payload: Uint8Array): [Buffer, Uint8Array] {
  const head = Buffer.alloc(5);
  head.writeUInt8(storageClass, 0);
  head.writeUInt32BE(payload.length, 1);
  return [head, payload];
}
