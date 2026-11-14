import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

export const MAX_STATE_BYTES = 2_048;
const MAX_COLOR_LENGTH = 16;

export type AwarenessState = Record<string, unknown> | null;

export interface AwarenessEntry {
  clientId: number;
  clock: number;
  state: AwarenessState;
}

export interface PresenceUser {
  id: string;
  name: string;
}

export type FilterResult =
  | { ok: true; update: Uint8Array; clientId: number; clock: number }
  | { ok: false; code: 4400 | 4403; reason: string };

const utf8 = new TextEncoder();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface RawEntry {
  clientId: number;
  clock: number;
  json: string;
}

function readEntries(update: Uint8Array): RawEntry[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const entries: RawEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const json = decoding.readVarString(decoder);
    entries.push({ clientId, clock, json });
  }
  if (decoding.hasContent(decoder)) throw new Error('trailing bytes');
  return entries;
}

/** Encodes entries in the y-protocols awareness update format. */
export function encodeAwarenessEntries(entries: AwarenessEntry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, JSON.stringify(entry.state));
  }
  return encoding.toUint8Array(encoder);
}

/**
 * Returns the presence state the server stores for a client state: the
 * authenticated user's id and name, plus the client's colour and cursor when well-formed.
 */
export function presenceState(state: Record<string, unknown>, user: PresenceUser): Record<string, unknown> {
  const clientUser = isPlainObject(state.user) ? state.user : {};
  const color =
    typeof clientUser.color === 'string' && clientUser.color.length <= MAX_COLOR_LENGTH
      ? clientUser.color
      : undefined;
  const result: Record<string, unknown> = {
    user: color === undefined ? { id: user.id, name: user.name } : { id: user.id, name: user.name, color },
  };
  const cursor = state.cursor;
  if (isPlainObject(cursor) && Number.isInteger(cursor.anchor) && Number.isInteger(cursor.head)) {
    result.cursor = { anchor: cursor.anchor, head: cursor.head };
  }
  return result;
}

/**
 * Validates an awareness update from a connection and returns it re-encoded
 * with server-assigned identity, or the close code to use.
 */
export function filterAwarenessUpdate(
  update: Uint8Array,
  context: { pinnedClientId: number | null; user: PresenceUser },
): FilterResult {
  let entries: RawEntry[];
  try {
    entries = readEntries(update);
  } catch {
    return { ok: false, code: 4400, reason: 'malformed awareness update' };
  }
  if (entries.length === 0) return { ok: false, code: 4400, reason: 'empty awareness update' };

  const clientId = context.pinnedClientId ?? entries[0].clientId;
  const filtered: AwarenessEntry[] = [];
  let clock = 0;
  for (const entry of entries) {
    if (entry.clientId !== clientId) {
      return { ok: false, code: 4403, reason: 'awareness client id not allowed' };
    }
    if (utf8.encode(entry.json).byteLength > MAX_STATE_BYTES) {
      return { ok: false, code: 4400, reason: 'awareness state too large' };
    }
    let state: unknown;
    try {
      state = JSON.parse(entry.json);
    } catch {
      return { ok: false, code: 4400, reason: 'awareness state is not JSON' };
    }
    if (state !== null && !isPlainObject(state)) {
      return { ok: false, code: 4400, reason: 'awareness state must be an object or null' };
    }
    filtered.push({
      clientId,
      clock: entry.clock,
      state: state === null ? null : presenceState(state, context.user),
    });
    clock = Math.max(clock, entry.clock);
  }
  return { ok: true, update: encodeAwarenessEntries(filtered), clientId, clock };
}
