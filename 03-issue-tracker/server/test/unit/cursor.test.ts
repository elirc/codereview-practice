import { describe, expect, it } from 'vitest';
import {
  buildPage,
  decodeCursor,
  encodeCursor,
  isCursorTimestamp,
  type Cursor,
} from '../../src/lib/cursor.js';
import { AppError } from '../../src/lib/errors.js';

const ID = '3f1c2b9e-8d4a-4c1e-9b7f-0a1b2c3d4e5f';

function raw(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).code).toBe('invalid_cursor');
    return;
  }
  throw new Error('expected invalid_cursor');
}

describe('cursor encoding', () => {
  it('round-trips a timestamp cursor with microseconds', () => {
    const cursor: Cursor = { s: 'created', v: '2026-03-02T09:00:01.123456Z', id: ID };
    expect(decodeCursor(encodeCursor(cursor), 'created')).toEqual(cursor);
  });

  it('round-trips a priority cursor', () => {
    const cursor: Cursor = { s: 'priority', v: 3, id: ID };
    expect(decodeCursor(encodeCursor(cursor), 'priority')).toEqual(cursor);
  });

  it('is base64url JSON with s, v and id', () => {
    const encoded = encodeCursor({ s: 'updated', v: '2026-01-01T00:00:00.000000Z', id: ID });
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toEqual({
      s: 'updated',
      v: '2026-01-01T00:00:00.000000Z',
      id: ID,
    });
  });

  it('rejects a cursor issued for a different sort', () => {
    const encoded = encodeCursor({ s: 'created', v: '2026-03-02T09:00:01.000000Z', id: ID });
    expectInvalid(() => decodeCursor(encoded, 'updated'));
  });

  it('rejects malformed input', () => {
    expectInvalid(() => decodeCursor('not base64!', 'created'));
    expectInvalid(() => decodeCursor(Buffer.from('{oops').toString('base64url'), 'created'));
    expectInvalid(() => decodeCursor(raw([1, 2, 3]), 'created'));
    expectInvalid(() => decodeCursor(raw('created'), 'created'));
  });

  it('rejects valid JSON with the wrong shape', () => {
    const v = '2026-03-02T09:00:01.000000Z';
    expectInvalid(() => decodeCursor(raw({ s: 'created', v }), 'created'));
    expectInvalid(() => decodeCursor(raw({ s: 'created', v, id: 'nope' }), 'created'));
    expectInvalid(() => decodeCursor(raw({ s: 'created', v, id: ID, extra: 1 }), 'created'));
    expectInvalid(() => decodeCursor(raw({ s: 'created', v: 12, id: ID }), 'created'));
    expectInvalid(() => decodeCursor(raw({ s: 'priority', v: '3', id: ID }), 'priority'));
    expectInvalid(() => decodeCursor(raw({ s: 'priority', v: 9, id: ID }), 'priority'));
  });

  it('rejects impossible timestamps that the database would refuse', () => {
    expect(isCursorTimestamp('2026-02-30T00:00:00.000000Z')).toBe(false);
    expect(isCursorTimestamp('2026-13-01T00:00:00.000000Z')).toBe(false);
    expect(isCursorTimestamp('2026-01-01T24:00:00.000000Z')).toBe(false);
    expect(isCursorTimestamp('2026-01-01 00:00:00')).toBe(false);
    expect(isCursorTimestamp('2028-02-29T23:59:59.999999Z')).toBe(true);
  });
});

describe('buildPage', () => {
  const rows = [1, 2, 3].map((n) => ({ n, id: ID }));
  const cursorFor = (row: { n: number; id: string }): Cursor => ({
    s: 'priority',
    v: row.n,
    id: row.id,
  });

  it('returns no cursor when the extra row is absent', () => {
    expect(buildPage(rows, 3, cursorFor)).toEqual({ rows, nextCursor: null });
  });

  it('derives the cursor from the last returned row when there is more', () => {
    const page = buildPage(rows, 2, cursorFor);
    expect(page.rows).toHaveLength(2);
    expect(decodeCursor(page.nextCursor as string, 'priority')).toEqual({
      s: 'priority',
      v: 2,
      id: ID,
    });
  });
});
