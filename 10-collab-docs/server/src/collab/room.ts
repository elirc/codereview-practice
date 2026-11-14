import * as Y from 'yjs';
import type { Logger } from '../lib/logger.js';
import { SerialQueue } from '../lib/serialQueue.js';
import { encodeControl, encodeSyncUpdate, type ControlMessage } from '../ws/codec.js';
import type { AppendAuthorizer, AppendInput, AppendResult, DocLog } from './docStore.js';

/** The storage operations a room needs. */
export interface RoomStore {
  load(docId: string): Promise<DocLog>;
  readSince(docId: string, afterSeq: number): Promise<DocLog>;
  append(input: AppendInput): Promise<AppendResult>;
}

/** A local connection joined to a room. */
export interface RoomPeer {
  readonly userId: string | null;
  send(frame: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface RoomOptions {
  docId: string;
  workspaceId: string;
  store: RoomStore;
  logger: Logger;
}

interface Pending {
  update: Uint8Array;
  origin: RoomPeer | null;
}

const SERVER_ORIGIN = Symbol('server');

/** One instance's in-memory state for an open document. */
export class Room {
  readonly docId: string;
  readonly workspaceId: string;
  readonly doc: Y.Doc;
  readonly peers = new Set<RoomPeer>();
  readonly queue = new SerialQueue();
  /** Every update with `seq <= appliedSeq` has been applied to `doc`. */
  appliedSeq = 0;
  pendingJoins = 0;
  idleSince: Date | null = null;
  closing = false;

  protected readonly store: RoomStore;
  protected readonly log: Logger;
  private loaded = false;
  private early: Array<Pending & { seq: number }> = [];
  private readonly buffer = new Map<number, Pending>();
  private catchUpRun: Promise<void> | null = null;
  private catchUpAgain = false;

  constructor(options: RoomOptions) {
    this.docId = options.docId;
    this.workspaceId = options.workspaceId;
    this.store = options.store;
    this.log = options.logger.child({ docId: options.docId });
    this.doc = new Y.Doc({ gc: true });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const frame = encodeSyncUpdate(update);
      for (const peer of this.peers) {
        if (peer !== origin) peer.send(frame);
      }
    });
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Seqs held back until the updates before them arrive. */
  get bufferedSeqs(): number[] {
    return [...this.buffer.keys()].sort((a, b) => a - b);
  }

  /** Loads the stored log, then integrates whatever arrived while loading. */
  async load(): Promise<void> {
    const log = await this.store.load(this.docId);
    if (log.snapshot) this.applyState(log.snapshot.state, log.snapshot.uptoSeq);
    this.loaded = true;
    for (const entry of log.updates) this.integrate(entry.seq, entry.update, null);
    const early = this.early;
    this.early = [];
    for (const entry of early) this.integrate(entry.seq, entry.update, entry.origin);
  }

  /** Integrates a committed update into the room's document. */
  integrate(seq: number, update: Uint8Array, origin: RoomPeer | null): void {
    if (!this.loaded) {
      this.early.push({ seq, update, origin });
      return;
    }
    if (seq <= this.appliedSeq) return;
    if (seq === this.appliedSeq + 1) {
      this.apply(seq, update, origin);
      this.drainBuffer();
      return;
    }
    if (!this.buffer.has(seq)) this.buffer.set(seq, { update, origin });
    void this.catchUp();
  }

  /** Reads what this room is missing from the database and integrates it. */
  catchUp(): Promise<void> {
    if (this.catchUpRun) {
      this.catchUpAgain = true;
      return this.catchUpRun;
    }
    this.catchUpRun = (async () => {
      try {
        do {
          this.catchUpAgain = false;
          await this.catchUpOnce();
        } while (this.catchUpAgain && !this.closing);
      } catch (error) {
        this.log.error({ err: error }, 'catch-up failed');
      } finally {
        this.catchUpRun = null;
      }
    })();
    return this.catchUpRun;
  }

  private async catchUpOnce(): Promise<void> {
    if (!this.loaded) return;
    const log = await this.store.readSince(this.docId, this.appliedSeq);
    if (this.closing) return;
    if (log.snapshot && log.snapshot.uptoSeq > this.appliedSeq) {
      this.applyState(log.snapshot.state, log.snapshot.uptoSeq);
    }
    for (const entry of log.updates) this.integrate(entry.seq, entry.update, null);
    this.drainBuffer();
  }

  /** Stores an update from a peer through the room's queue and integrates it once committed. */
  appendFromPeer(
    peer: RoomPeer,
    update: Uint8Array,
    authorize: AppendAuthorizer,
  ): Promise<AppendResult> {
    return this.queue.run(async () => {
      const result = await this.store.append({
        docId: this.docId,
        update,
        userId: peer.userId,
        authorize,
      });
      if (result.status === 'ok') this.committed(result.seq, update, peer);
      return result;
    });
  }

  /** Integrates an update this instance committed. */
  committed(seq: number, update: Uint8Array, origin: RoomPeer | null): void {
    this.integrate(seq, update, origin);
  }

  /** Returns the encoded state vector of the room's document. */
  stateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /** Sends a frame to every peer except `except`. */
  broadcast(frame: Uint8Array, except: RoomPeer | null = null): void {
    for (const peer of this.peers) {
      if (peer !== except) peer.send(frame);
    }
  }

  /** Sends a control message to every peer. */
  broadcastControl(message: ControlMessage): void {
    this.broadcast(encodeControl(message));
  }

  /** Closes every peer with the given code. */
  closePeers(code: number, reason: string): void {
    for (const peer of [...this.peers]) peer.close(code, reason);
  }

  addPeer(peer: RoomPeer): void {
    this.peers.add(peer);
    this.idleSince = null;
  }

  /** Removes a peer and returns whether the room became empty. */
  removePeer(peer: RoomPeer): boolean {
    this.peers.delete(peer);
    return this.peers.size === 0 && this.pendingJoins === 0;
  }

  /** Waits for queued work and releases the document. */
  async close(): Promise<void> {
    this.closing = true;
    await this.queue.drain();
    if (this.catchUpRun) await this.catchUpRun;
    this.doc.destroy();
  }

  private applyState(state: Uint8Array, uptoSeq: number): void {
    try {
      Y.applyUpdate(this.doc, state, SERVER_ORIGIN);
    } catch (error) {
      this.log.error({ err: error, uptoSeq }, 'snapshot could not be applied');
    }
    this.appliedSeq = uptoSeq;
    for (const seq of this.buffer.keys()) {
      if (seq <= uptoSeq) this.buffer.delete(seq);
    }
  }

  private apply(seq: number, update: Uint8Array, origin: RoomPeer | null): void {
    try {
      Y.applyUpdate(this.doc, update, origin ?? SERVER_ORIGIN);
    } catch (error) {
      this.log.error({ err: error, seq }, 'update could not be applied');
    }
    this.appliedSeq = seq;
  }

  private drainBuffer(): void {
    for (;;) {
      const next = this.buffer.get(this.appliedSeq + 1);
      if (!next) break;
      this.buffer.delete(this.appliedSeq + 1);
      this.apply(this.appliedSeq + 1, next.update, next.origin);
    }
    for (const seq of this.buffer.keys()) {
      if (seq <= this.appliedSeq) this.buffer.delete(seq);
    }
  }
}
