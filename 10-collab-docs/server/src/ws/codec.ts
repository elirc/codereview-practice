import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from 'y-protocols/sync';
import type { DocRole } from '../domain/roles.js';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_CONTROL = 2;

export const CloseCode = {
  Replaced: 1000,
  GoingAway: 1001,
  ServerError: 1011,
  Malformed: 4400,
  SessionEnded: 4401,
  Forbidden: 4403,
  Gone: 4404,
  TooLarge: 4413,
  RateLimited: 4429,
} as const;

export type ControlMessage =
  | { type: 'hello'; role: DocRole; connectionId: string; userId: string | null }
  | { type: 'role'; role: DocRole }
  | { type: 'meta'; title: string }
  | { type: 'comments_changed' };

export type Frame =
  | { type: 'sync-step1'; stateVector: Uint8Array }
  | { type: 'sync-step2'; update: Uint8Array }
  | { type: 'sync-update'; update: Uint8Array }
  | { type: 'awareness'; update: Uint8Array }
  | { type: 'control'; message: unknown };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function readFrame(decoder: decoding.Decoder): Frame {
  const messageType = decoding.readVarUint(decoder);
  switch (messageType) {
    case MESSAGE_SYNC: {
      const step = decoding.readVarUint(decoder);
      const payload = decoding.readVarUint8Array(decoder);
      if (step === messageYjsSyncStep1) return { type: 'sync-step1', stateVector: payload };
      if (step === messageYjsSyncStep2) return { type: 'sync-step2', update: payload };
      if (step === messageYjsUpdate) return { type: 'sync-update', update: payload };
      throw new ProtocolError(`unknown sync step ${step}`);
    }
    case MESSAGE_AWARENESS:
      return { type: 'awareness', update: decoding.readVarUint8Array(decoder) };
    case MESSAGE_CONTROL: {
      const text = decoding.readVarString(decoder);
      try {
        return { type: 'control', message: JSON.parse(text) as unknown };
      } catch {
        throw new ProtocolError('control frame is not JSON');
      }
    }
    default:
      throw new ProtocolError(`unknown message type ${messageType}`);
  }
}

/** Decodes one binary frame; throws `ProtocolError` for anything malformed or with trailing bytes. */
export function decodeFrame(data: Uint8Array): Frame {
  const decoder = decoding.createDecoder(data);
  let frame: Frame;
  try {
    frame = readFrame(decoder);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError('truncated frame');
  }
  if (decoding.hasContent(decoder)) throw new ProtocolError('trailing bytes after message');
  return frame;
}

function syncFrame(step: number, payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, step);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

/** Encodes a SyncStep1 frame carrying a state vector. */
export function encodeSyncStep1(stateVector: Uint8Array): Uint8Array {
  return syncFrame(messageYjsSyncStep1, stateVector);
}

/** Encodes a SyncStep2 frame carrying an update. */
export function encodeSyncStep2(update: Uint8Array): Uint8Array {
  return syncFrame(messageYjsSyncStep2, update);
}

/** Encodes a sync Update frame. */
export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  return syncFrame(messageYjsUpdate, update);
}

/** Encodes an awareness frame around an encoded awareness update. */
export function encodeAwareness(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Encodes a server control frame. */
export function encodeControl(message: ControlMessage): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_CONTROL);
  encoding.writeVarString(encoder, JSON.stringify(message));
  return encoding.toUint8Array(encoder);
}
