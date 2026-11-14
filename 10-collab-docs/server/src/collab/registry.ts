import { fromBase64, toBase64 } from '../lib/bytes.js';
import type { Logger } from '../lib/logger.js';
import { CloseCode } from '../ws/codec.js';
import type { Bus, BusHandler } from './bus.js';
import { docBusMessage, docChannel, type DocBusMessage } from './busMessages.js';
import { Room, type RoomPeer, type RoomStore } from './room.js';

export interface RegistryOptions {
  store: RoomStore;
  bus: Bus;
  logger: Logger;
  roomIdleMs: number;
}

/** The open rooms of this instance, keyed by document id. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly store: RoomStore;
  private readonly bus: Bus;
  private readonly log: Logger;
  private readonly roomIdleMs: number;
  private readonly ready = new Map<Room, Promise<void>>();
  private readonly handlers = new Map<Room, BusHandler>();

  constructor(options: RegistryOptions) {
    this.store = options.store;
    this.bus = options.bus;
    this.log = options.logger;
    this.roomIdleMs = options.roomIdleMs;
    this.bus.onReady(() => {
      for (const room of this.all()) void room.catchUp();
    });
  }

  get instanceId(): string {
    return this.bus.instanceId;
  }

  /** Returns the open room for a document, if this instance has one. */
  get(docId: string): Room | undefined {
    return this.rooms.get(docId);
  }

  /** Returns every open room. */
  all(): Room[] {
    return [...this.rooms.values()];
  }

  /**
   * Returns the document's room once it has loaded, opening it if needed.
   * The caller must follow with `attach` or `cancelJoin`.
   */
  async acquire(docId: string, workspaceId: string): Promise<Room> {
    let room = this.rooms.get(docId);
    if (!room) room = this.open(docId, workspaceId);
    room.pendingJoins += 1;
    room.idleSince = null;
    try {
      await this.ready.get(room);
      return room;
    } catch (error) {
      room.pendingJoins -= 1;
      throw error;
    }
  }

  /** Adds an acquired peer to its room. */
  attach(room: Room, peer: RoomPeer): void {
    room.pendingJoins -= 1;
    room.addPeer(peer);
  }

  /** Gives back an acquisition that will not be attached. */
  cancelJoin(room: Room, now: Date): void {
    room.pendingJoins -= 1;
    if (room.peers.size === 0 && room.pendingJoins === 0) room.idleSince = now;
  }

  /** Removes a peer from its room and marks the room idle when it empties. */
  detach(room: Room, peer: RoomPeer, now: Date): void {
    if (room.removePeer(peer)) room.idleSince = now;
  }

  /** Catches up every loaded room whose document head is ahead of what it has applied. */
  async catchUpStale(): Promise<void> {
    const rooms = this.all().filter((room) => room.isLoaded && !room.closing);
    if (rooms.length === 0) return;
    const heads = await this.store.headSeqs(rooms.map((room) => room.docId));
    await Promise.all(
      rooms
        .filter((room) => (heads.get(room.docId) ?? 0) > room.appliedSeq)
        .map((room) => room.catchUp()),
    );
  }

  /** Closes rooms that have been empty for at least the idle period; returns how many. */
  async sweepIdle(now: Date): Promise<number> {
    const idle = this.all().filter(
      (room) =>
        room.idleSince !== null &&
        room.peers.size === 0 &&
        room.pendingJoins === 0 &&
        now.getTime() - room.idleSince.getTime() >= this.roomIdleMs,
    );
    for (const room of idle) await this.closeRoom(room);
    return idle.length;
  }

  /** Waits for every room's queued work. */
  async drainAll(): Promise<void> {
    await Promise.all(this.all().map((room) => room.queue.drain()));
  }

  /** Closes every room. */
  async closeAll(): Promise<void> {
    await Promise.all(this.all().map((room) => this.closeRoom(room)));
  }

  /** Publishes an update committed by this instance. */
  publishUpdate(docId: string, seq: number, update: Uint8Array): void {
    this.bus
      .publish(docChannel(docId), {
        kind: 'update',
        instanceId: this.bus.instanceId,
        seq,
        update: toBase64(update),
      })
      .catch((error: unknown) => this.log.warn({ err: error, docId, seq }, 'update publish failed'));
  }

  /** Publishes an awareness update relayed by this instance. */
  publishAwareness(docId: string, update: Uint8Array): void {
    this.bus
      .publish(docChannel(docId), {
        kind: 'awareness',
        instanceId: this.bus.instanceId,
        update: toBase64(update),
      })
      .catch((error: unknown) => this.log.warn({ err: error, docId }, 'awareness publish failed'));
  }

  private open(docId: string, workspaceId: string): Room {
    const room = new Room({
      docId,
      workspaceId,
      store: this.store,
      logger: this.log,
      onCommitted: (seq, update) => this.publishUpdate(docId, seq, update),
      onAwareness: (update) => this.publishAwareness(docId, update),
    });
    this.rooms.set(docId, room);
    const ready = this.prepare(room);
    this.ready.set(room, ready);
    ready.catch((error: unknown) => {
      this.log.error({ err: error, docId }, 'room failed to open');
      if (this.rooms.get(docId) === room) this.rooms.delete(docId);
      this.ready.delete(room);
      void this.release(room);
    });
    return room;
  }

  private async prepare(room: Room): Promise<void> {
    const handler: BusHandler = (raw) => this.onDocMessage(room, raw);
    this.handlers.set(room, handler);
    await this.bus.subscribe(docChannel(room.docId), handler);
    await room.load();
  }

  private async release(room: Room): Promise<void> {
    const handler = this.handlers.get(room);
    if (!handler) return;
    this.handlers.delete(room);
    await this.bus.unsubscribe(docChannel(room.docId), handler);
  }

  private async closeRoom(room: Room): Promise<void> {
    if (this.rooms.get(room.docId) === room) this.rooms.delete(room.docId);
    this.ready.delete(room);
    await room.close();
    await this.release(room);
  }

  private onDocMessage(room: Room, raw: unknown): void {
    const parsed = docBusMessage.safeParse(raw);
    if (!parsed.success) {
      this.log.warn({ docId: room.docId }, 'ignoring malformed bus message');
      return;
    }
    this.handleDocMessage(room, parsed.data);
  }

  private handleDocMessage(room: Room, message: DocBusMessage): void {
    switch (message.kind) {
      case 'update':
        if (message.instanceId === this.bus.instanceId) return;
        room.integrate(message.seq, fromBase64(message.update), null);
        return;
      case 'meta':
        room.broadcastControl({ type: 'meta', title: message.title });
        return;
      case 'comments':
        room.broadcastControl({ type: 'comments_changed' });
        return;
      case 'trashed':
        room.closePeers(CloseCode.Gone, 'document trashed');
        return;
      case 'awareness':
        if (message.instanceId === this.bus.instanceId) return;
        room.applyRemoteAwareness(fromBase64(message.update));
        return;
      case 'perm':
        return;
    }
  }
}
