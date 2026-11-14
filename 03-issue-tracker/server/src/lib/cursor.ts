import { AppError } from './errors.js';

export type CursorSort = 'created' | 'updated' | 'priority' | 'joined';

export interface Cursor {
  s: CursorSort;
  v: string | number;
  id: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

export function invalidCursor(): AppError {
  return new AppError(400, 'invalid_cursor', 'The pagination cursor is not valid for this list.');
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ s: cursor.s, v: cursor.v, id: cursor.id })).toString(
    'base64url',
  );
}

/** A UTC timestamp with microseconds, as produced by `isoMicros` in SQL. */
export function isCursorTimestamp(value: string): boolean {
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

function isValidValue(sort: CursorSort, value: unknown): boolean {
  if (sort === 'priority') {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4;
  }
  return typeof value === 'string' && isCursorTimestamp(value);
}

/** Decodes a cursor issued for `expectedSort`; anything else is `400 invalid_cursor`. */
export function decodeCursor(raw: string, expectedSort: CursorSort): Cursor {
  if (!BASE64URL.test(raw)) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor();
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== 'id' || keys[1] !== 's' || keys[2] !== 'v') {
    throw invalidCursor();
  }
  const { s, v, id } = record;
  if (
    s !== expectedSort ||
    typeof id !== 'string' ||
    !UUID.test(id) ||
    !isValidValue(expectedSort, v)
  ) {
    throw invalidCursor();
  }
  return { s: expectedSort, v: v as string | number, id };
}

/**
 * Trims a `limit + 1` result to `limit` rows and derives the next cursor from the last row
 * returned, only when the extra row proves there is more.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  cursorFor: (row: T) => Cursor,
): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) {
    return { rows, nextCursor: null };
  }
  const pageRows = rows.slice(0, limit);
  return { rows: pageRows, nextCursor: encodeCursor(cursorFor(pageRows[pageRows.length - 1])) };
}
