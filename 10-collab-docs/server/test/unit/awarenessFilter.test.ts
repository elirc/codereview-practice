import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import {
  encodeAwarenessEntries,
  filterAwarenessUpdate,
  type AwarenessEntry,
} from '../../src/collab/awarenessFilter.js';

const user = { id: 'user-1', name: 'Ada' };

function decode(update: Uint8Array): AwarenessEntry[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const entries: AwarenessEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    entries.push({
      clientId: decoding.readVarUint(decoder),
      clock: decoding.readVarUint(decoder),
      state: JSON.parse(decoding.readVarString(decoder)),
    });
  }
  return entries;
}

function update(...entries: Array<[number, number, unknown]>): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const [clientId, clock, state] of entries) {
    encoding.writeVarUint(encoder, clientId);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, typeof state === 'string' ? state : JSON.stringify(state));
  }
  return encoding.toUint8Array(encoder);
}

describe('filterAwarenessUpdate', () => {
  it('pins the first client id and refuses any other', () => {
    const first = filterAwarenessUpdate(update([10, 1, {}]), { pinnedClientId: null, user });
    expect(first).toMatchObject({ ok: true, clientId: 10, clock: 1 });
    const other = filterAwarenessUpdate(update([11, 1, {}]), { pinnedClientId: 10, user });
    expect(other).toMatchObject({ ok: false, code: 4403 });
    const mixed = filterAwarenessUpdate(update([10, 2, {}], [11, 1, {}]), {
      pinnedClientId: null,
      user,
    });
    expect(mixed).toMatchObject({ ok: false, code: 4403 });
  });

  it('replaces the claimed identity and keeps only colour and cursor', () => {
    const result = filterAwarenessUpdate(
      update([10, 3, {
        user: { id: 'someone-else', name: 'Mallory', color: '#ff0000', admin: true },
        cursor: { anchor: 2, head: 5, extra: 'x' },
        secret: 'drop me',
      }]),
      { pinnedClientId: null, user },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(decode(result.update)).toEqual([
      {
        clientId: 10,
        clock: 3,
        state: { user: { id: 'user-1', name: 'Ada', color: '#ff0000' }, cursor: { anchor: 2, head: 5 } },
      },
    ]);
  });

  it('drops an overlong colour and a cursor with non-integer positions', () => {
    const result = filterAwarenessUpdate(
      update([10, 1, { user: { color: 'x'.repeat(17) }, cursor: { anchor: 1.5, head: 2 } }]),
      { pinnedClientId: null, user },
    );
    if (!result.ok) throw new Error('expected ok');
    expect(decode(result.update)[0].state).toEqual({ user: { id: 'user-1', name: 'Ada' } });
  });

  it('passes a null state through as a removal', () => {
    const result = filterAwarenessUpdate(update([10, 4, null]), { pinnedClientId: 10, user });
    if (!result.ok) throw new Error('expected ok');
    expect(decode(result.update)).toEqual([{ clientId: 10, clock: 4, state: null }]);
  });

  it('refuses states over 2048 bytes, non-object states and invalid JSON', () => {
    const big = { pad: 'é'.repeat(1100) };
    for (const state of [big, [1, 2], 'not json', 42]) {
      expect(filterAwarenessUpdate(update([10, 1, state]), { pinnedClientId: null, user })).toMatchObject({
        ok: false,
        code: 4400,
      });
    }
  });

  it('accepts a state of exactly 2048 bytes', () => {
    const json = JSON.stringify({ p: '' });
    const padded = JSON.stringify({ p: 'a'.repeat(2048 - json.length) });
    expect(padded.length).toBe(2048);
    expect(filterAwarenessUpdate(update([10, 1, padded]), { pinnedClientId: null, user }).ok).toBe(true);
  });

  it('refuses truncated updates and trailing bytes', () => {
    const valid = update([10, 1, {}]);
    expect(filterAwarenessUpdate(valid.subarray(0, valid.length - 1), { pinnedClientId: null, user })).toMatchObject({
      ok: false,
      code: 4400,
    });
    const trailing = new Uint8Array([...valid, 0]);
    expect(filterAwarenessUpdate(trailing, { pinnedClientId: null, user })).toMatchObject({
      ok: false,
      code: 4400,
    });
  });

  it('encodes entries in the awareness wire format', () => {
    const entries = [{ clientId: 7, clock: 9, state: { user: { id: 'u', name: 'n' } } }];
    expect(decode(encodeAwarenessEntries(entries))).toEqual(entries);
  });
});
