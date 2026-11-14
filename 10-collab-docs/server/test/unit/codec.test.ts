import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  decodeFrame,
  encodeAwareness,
  encodeControl,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  ProtocolError,
} from '../../src/ws/codec.js';

function sampleUpdate(): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'hello');
  return Y.encodeStateAsUpdate(doc);
}

function withTrailingByte(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(frame.length + 1);
  out.set(frame);
  out[frame.length] = 7;
  return out;
}

describe('protocol codec', () => {
  it('round-trips SyncStep1 with a state vector', () => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'abc');
    const stateVector = Y.encodeStateVector(doc);
    expect(decodeFrame(encodeSyncStep1(stateVector))).toEqual({ type: 'sync-step1', stateVector });
  });

  it('round-trips SyncStep2 and Update', () => {
    const update = sampleUpdate();
    expect(decodeFrame(encodeSyncStep2(update))).toEqual({ type: 'sync-step2', update });
    expect(decodeFrame(encodeSyncUpdate(update))).toEqual({ type: 'sync-update', update });
  });

  it('round-trips awareness frames', () => {
    const payload = new Uint8Array([1, 2, 3]);
    expect(decodeFrame(encodeAwareness(payload))).toEqual({ type: 'awareness', update: payload });
  });

  it('decodes control frames as JSON', () => {
    const frame = encodeControl({ type: 'role', role: 'viewer' });
    expect(decodeFrame(frame)).toEqual({ type: 'control', message: { type: 'role', role: 'viewer' } });
  });

  it('rejects trailing bytes after any message', () => {
    for (const frame of [
      encodeSyncStep1(new Uint8Array([0])),
      encodeSyncUpdate(sampleUpdate()),
      encodeAwareness(new Uint8Array([0])),
      encodeControl({ type: 'comments_changed' }),
    ]) {
      expect(() => decodeFrame(withTrailingByte(frame))).toThrow(ProtocolError);
    }
  });

  it('rejects unknown message types and sync steps', () => {
    const unknownType = encoding.createEncoder();
    encoding.writeVarUint(unknownType, 9);
    expect(() => decodeFrame(encoding.toUint8Array(unknownType))).toThrow(/unknown message type/);

    const unknownStep = encoding.createEncoder();
    encoding.writeVarUint(unknownStep, 0);
    encoding.writeVarUint(unknownStep, 5);
    encoding.writeVarUint8Array(unknownStep, new Uint8Array([1]));
    expect(() => decodeFrame(encoding.toUint8Array(unknownStep))).toThrow(/unknown sync step/);
  });

  it('rejects truncated and empty frames', () => {
    const frame = encodeSyncUpdate(sampleUpdate());
    expect(() => decodeFrame(frame.subarray(0, frame.length - 2))).toThrow(ProtocolError);
    expect(() => decodeFrame(new Uint8Array(0))).toThrow(ProtocolError);
  });

  it('rejects control frames that are not JSON', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 2);
    encoding.writeVarString(encoder, '{not json');
    expect(() => decodeFrame(encoding.toUint8Array(encoder))).toThrow(ProtocolError);
  });
});
