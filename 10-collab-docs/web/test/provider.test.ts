import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
  CollabProvider,
  reconnectDelay,
  type Scheduler,
  type SocketLike,
} from '../src/collab/provider';

class FakeSocket implements SocketLike {
  binaryType = 'blob';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: Uint8Array[] = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }

  deliver(frame: Uint8Array): void {
    const copy = frame.slice();
    this.onmessage?.({ data: copy.buffer });
  }

  /** The sync step of each sent sync frame, in order. */
  syncSteps(): number[] {
    return this.sent
      .map((frame) => decoding.createDecoder(frame))
      .filter((decoder) => decoding.readVarUint(decoder) === 0)
      .map((decoder) => decoding.readVarUint(decoder));
  }
}

class FakeScheduler implements Scheduler {
  readonly delays: number[] = [];
  private pending: Array<() => void> = [];

  setTimeout(callback: () => void, ms: number): unknown {
    this.delays.push(ms);
    this.pending.push(callback);
    return this.pending.length;
  }

  clearTimeout(): void {
    this.pending = [];
  }

  runNext(): void {
    const next = this.pending.shift();
    next?.();
  }
}

function control(message: object): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarString(encoder, JSON.stringify(message));
  return encoding.toUint8Array(encoder);
}

function serverSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

function setup(random = () => 0) {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const provider = new CollabProvider({
    url: 'ws://test/ws/docs/1',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    random,
    scheduler,
  });
  provider.connect();
  return { provider, sockets, scheduler };
}

const hello = (role: string) => control({ type: 'hello', role, connectionId: 'c1', userId: 'u1' });

describe('reconnectDelay', () => {
  it('doubles from 500 ms up to 30 s', () => {
    const delays = Array.from({ length: 9 }, (_, attempt) => reconnectDelay(attempt, () => 0));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('adds at most 20% jitter', () => {
    expect(reconnectDelay(0, () => 1)).toBe(600);
    expect(reconnectDelay(10, () => 0.5)).toBe(33_000);
  });
});

describe('CollabProvider', () => {
  it('sends its state vector on every open', () => {
    const { sockets, scheduler } = setup();
    sockets[0].open();
    expect(sockets[0].syncSteps()).toEqual([syncProtocol.messageYjsSyncStep1]);
    sockets[0].serverClose(1001);
    scheduler.runNext();
    sockets[1].open();
    expect(sockets[1].syncSteps()).toEqual([syncProtocol.messageYjsSyncStep1]);
  });

  it('backs off between reconnects and resets after a hello', () => {
    const { sockets, scheduler } = setup();
    sockets[0].open();
    sockets[0].serverClose(1006);
    scheduler.runNext();
    sockets[1].serverClose(1006);
    scheduler.runNext();
    sockets[2].open();
    sockets[2].deliver(hello('editor'));
    sockets[2].serverClose(1001);
    expect(scheduler.delays).toEqual([500, 1000, 500]);
  });

  it.each([4401, 4403, 4404])('stops reconnecting after close code %i and explains why', (code) => {
    const { provider, sockets, scheduler } = setup();
    sockets[0].open();
    sockets[0].serverClose(code);
    expect(provider.status).toBe('stopped');
    expect(provider.stopReason).toMatch(/./);
    expect(scheduler.delays).toEqual([]);
  });

  it('sends local updates only while the announced role can edit', () => {
    const { provider, sockets } = setup();
    sockets[0].open();
    sockets[0].deliver(hello('viewer'));
    const before = sockets[0].sent.length;
    provider.doc.getText('content').insert(0, 'local');
    expect(sockets[0].sent.length).toBe(before);
  });

  it('answers the server SyncStep1 with its missing state when editing', () => {
    const { provider, sockets } = setup();
    sockets[0].open();
    provider.doc.getText('content').insert(0, 'offline');
    sockets[0].deliver(hello('editor'));
    sockets[0].deliver(serverSyncStep1(new Y.Doc()));
    expect(sockets[0].syncSteps()).toContain(syncProtocol.messageYjsSyncStep2);
    provider.doc.getText('content').insert(7, '!');
    expect(sockets[0].syncSteps().at(-1)).toBe(syncProtocol.messageYjsUpdate);
  });

  it('discards unsent edits and reloads when told it is read-only', () => {
    const { provider, sockets } = setup();
    const docs: Y.Doc[] = [];
    provider.on('doc', (doc) => docs.push(doc));
    const original = provider.doc;
    sockets[0].open();
    original.getText('content').insert(0, 'not allowed');
    sockets[0].deliver(hello('viewer'));
    expect(provider.doc).not.toBe(original);
    expect(provider.doc.getText('content').toString()).toBe('');
    expect(docs).toEqual([provider.doc]);
    expect(sockets).toHaveLength(2);
    expect(sockets[0].syncSteps()).not.toContain(syncProtocol.messageYjsSyncStep2);
  });

  it('reports role changes and comment notifications', () => {
    const { provider, sockets } = setup();
    const roles: Array<string | null> = [];
    let comments = 0;
    provider.on('role', (role) => roles.push(role));
    provider.on('comments', () => {
      comments += 1;
    });
    sockets[0].open();
    sockets[0].deliver(hello('viewer'));
    sockets[0].deliver(control({ type: 'role', role: 'editor' }));
    sockets[0].deliver(control({ type: 'comments_changed' }));
    expect(roles).toEqual(['viewer', 'editor']);
    expect(comments).toBe(1);
  });
});
