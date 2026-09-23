/**
 * Opaque offset cursor. Opaque so the encoding can change without breaking clients
 * that stored one, and validated so a malformed cursor fails loudly rather than
 * silently paging from zero.
 */
export function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^o:(\d+)$/.exec(raw);
  // Past a safe integer the offset reaches SQLite as a REAL, and OFFSET refuses it.
  const offset = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(offset)) throw new Error(`Invalid cursor: ${cursor}`);
  return offset;
}
