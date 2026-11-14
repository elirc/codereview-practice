import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { AppendInput, AppendResult, DocLog } from '../../src/collab/docStore.js';
import { Room, type RoomPeer, type RoomStore } from '../../src/collab/room.js';
import { createLogger } from '../../src/lib/logger.js';
import { decodeFrame } from '../../src/ws/codec.js';

/** Updates that type "a", "b", "c", ... one character each. */
function chain(count: number): Uint8Array[] {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  for (let i = 0; i < count; i += 1) doc.getText('content').insert(i, String.fromCharCode(97 + i));
  return updates;
}

function stateOf(updates: Uint8Array[]): Uint8Array {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return Y.encodeStateAsUpdate(doc);
}

class FakeStore implements RoomStore {
  log: DocLog = { snapshot: null, updates: [] };
  readSinceCalls: number[] = [];
  appended: AppendInput[] = [];
  nextSeq = 1;
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  release(): void {
    this.openGate?.();
    this.gate = null;
  }

  async load(): Promise<DocLog> {
    if (this.gate) await this.gate;
    return this.log;
  }

  async readSince(_docId: string, afterSeq: number): Promise<DocLog> {
    this.readSinceCalls.push(afterSeq);
    const snapshot =
      this.log.snapshot && this.log.snapshot.uptoSeq > afterSeq ? this.log.snapshot : null;
    const from = snapshot ? snapshot.uptoSeq : afterSeq;
    return { snapshot, updates: this.log.updates.filter((entry) => entry.seq > from) };
  }

  async headSeqs(): Promise<Map<string, number>> {
    return new Map();
  }

  async append(input: AppendInput): Promise<AppendResult> {
    this.appended.push(input);
    return { status: 'ok', seq: this.nextSeq++ };
  }
}

class FakePeer implements RoomPeer {
  readonly userId = 'user-1';
  readonly sent: Uint8Array[] = [];
  send(frame: Uint8Array): void {
    this.sent.push(frame);
  }
  close(): void {}
}

function newRoom(store: FakeStore): Room {
  return new Room({
    docId: 'doc-1',
    workspaceId: 'ws-1',
    store,
    logger: createLogger('silent'),
  });
}

const text = (room: Room) => room.doc.getText('content').toString();

describe('Room.integrate', () => {
  it('applies updates that arrive in order', async () => {
    const store = new FakeStore();
    const room = newRoom(store);
    await room.load();
    const updates = chain(3);
    updates.forEach((update, index) => room.integrate(index + 1, update, null));
    expect(text(room)).toBe('abc');
    expect(room.appliedSeq).toBe(3);
    expect(store.readSinceCalls).toEqual([]);
  });

  it('buffers an early update and applies it once its predecessor arrives', async () => {
    const store = new FakeStore();
    const room = newRoom(store);
    await room.load();
    const [first, second] = chain(2);
    room.integrate(2, second, null);
    expect(room.appliedSeq).toBe(0);
    expect(room.bufferedSeqs).toEqual([2]);
    room.integrate(1, first, null);
    expect(room.appliedSeq).toBe(2);
    expect(room.bufferedSeqs).toEqual([]);
    expect(text(room)).toBe('ab');
  });

  it('applies a duplicate only once', async () => {
    const store = new FakeStore();
    const room = newRoom(store);
    await room.load();
    const [first] = chain(1);
    const peer = new FakePeer();
    room.addPeer(peer);
    room.integrate(1, first, null);
    room.integrate(1, first, null);
    expect(room.appliedSeq).toBe(1);
    expect(peer.sent).toHaveLength(1);
  });

  it('fills a gap from the store', async () => {
    const store = new FakeStore();
    const room = newRoom(store);
    await room.load();
    const updates = chain(3);
    store.log = { snapshot: null, updates: updates.map((update, i) => ({ seq: i + 1, update })) };
    room.integrate(3, updates[2], null);
    await room.catchUp();
    expect(store.readSinceCalls[0]).toBe(0);
    expect(room.appliedSeq).toBe(3);
    expect(text(room)).toBe('abc');
  });

  it('jumps to a snapshot that is ahead of appliedSeq', async () => {
    const store = new FakeStore();
    const room = newRoom(store);
    await room.load();
    const updates = chain(5);
    room.integrate(1, updates[0], null);
    store.log = {
      snapshot: { uptoSeq: 4, state: stateOf(updates.slice(0, 4)) },
      updates: [{ seq: 5, update: updates[4] }],
    };
    room.integrate(5, updates[4], null);
    await room.catchUp();
    expect(store.readSinceCalls).toContain(1);
    expect(room.appliedSeq).toBe(5);
    expect(text(room)).toBe('abcde');
  });

  it('integrates updates received while loading after the stored log', async () => {
    const store = new FakeStore();
    const updates = chain(3);
    store.log = { snapshot: null, updates: [{ seq: 1, update: updates[0] }] };
    store.hold();
    const room = newRoom(store);
    const loading = room.load();
    room.integrate(3, updates[2], null);
    room.integrate(2, updates[1], null);
    room.integrate(1, updates[0], null);
    store.release();
    await loading;
    expect(room.appliedSeq).toBe(3);
    expect(text(room)).toBe('abc');
  });

  it('broadcasts applied changes to every peer except the origin', async () => {
    const store = new FakeStore();
    const room = newRoom(store);
    await room.load();
    const author = new FakePeer();
    const reader = new FakePeer();
    room.addPeer(author);
    room.addPeer(reader);
    const [first] = chain(1);
    const result = await room.appendFromPeer(author, first, async () => true);
    expect(result).toEqual({ status: 'ok', seq: 1 });
    expect(author.sent).toHaveLength(0);
    expect(reader.sent).toHaveLength(1);
    expect(decodeFrame(reader.sent[0]).type).toBe('sync-update');
    expect(store.appended[0].userId).toBe('user-1');
  });
});
