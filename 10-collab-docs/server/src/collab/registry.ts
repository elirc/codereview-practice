import type { Logger } from '../lib/logger.js';
import { Room, type RoomPeer, type RoomStore } from './room.js';

export interface RegistryOptions {
  store: RoomStore;
  logger: Logger;
  roomIdleMs: number;
}

/** The open rooms of this instance, keyed by document id. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly store: RoomStore;
  private readonly log: Logger;
  private readonly roomIdleMs: number;
  private readonly ready = new Map<Room, Promise<void>>();

  constructor(options: RegistryOptions) {
    this.store = options.store;
    this.log = options.logger;
    this.roomIdleMs = options.roomIdleMs;
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

  private createRoom(docId: string, workspaceId: string): Room {
    return new Room({ docId, workspaceId, store: this.store, logger: this.log });
  }

  private async prepare(room: Room): Promise<void> {
    await room.load();
  }

  private async release(_room: Room): Promise<void> {}

  private open(docId: string, workspaceId: string): Room {
    const room = this.createRoom(docId, workspaceId);
    this.rooms.set(docId, room);
    const ready = this.prepare(room);
    this.ready.set(room, ready);
    ready.catch((error: unknown) => {
      this.log.error({ err: error, docId }, 'room failed to open');
      if (this.rooms.get(docId) === room) this.rooms.delete(docId);
      this.ready.delete(room);
      void this.release(room).catch(() => undefined);
    });
    return room;
  }

  private async closeRoom(room: Room): Promise<void> {
    if (this.rooms.get(room.docId) === room) this.rooms.delete(room.docId);
    this.ready.delete(room);
    await room.close();
    await this.release(room);
  }
}
