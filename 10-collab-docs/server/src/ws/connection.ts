import type WebSocket from 'ws';
import type { Room, RoomPeer } from '../collab/room.js';
import { TokenBucket } from '../domain/tokenBucket.js';
import { canEdit, type DocRole } from '../domain/roles.js';
import type { Logger } from '../lib/logger.js';
import type { DocAccess, Principal } from '../services/access.js';
import { CloseCode, encodeControl, encodeSyncStep1, type ControlMessage } from './codec.js';

export interface ConnectionAuth {
  userId: string | null;
  userName: string | null;
  sessionId: string | null;
  sessionExpiresAt: Date | null;
  linkId: string | null;
  linkExpiresAt: Date | null;
  role: DocRole;
  docEpoch: number;
  workspaceEpoch: number;
}

export interface ConnectionOptions {
  id: string;
  docId: string;
  workspaceId: string;
  socket: WebSocket;
  auth: ConnectionAuth;
  bucket: TokenBucket;
  logger: Logger;
}

/** One WebSocket connected to a document. */
export class Connection implements RoomPeer {
  readonly id: string;
  readonly docId: string;
  readonly workspaceId: string;
  readonly socket: WebSocket;
  readonly bucket: TokenBucket;
  readonly log: Logger;
  auth: ConnectionAuth;
  room: Room | null = null;
  awarenessClientId: number | null = null;
  awarenessClock = 0;
  alive = true;
  closed = false;
  draining = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: ConnectionOptions) {
    this.id = options.id;
    this.docId = options.docId;
    this.workspaceId = options.workspaceId;
    this.socket = options.socket;
    this.auth = options.auth;
    this.bucket = options.bucket;
    this.log = options.logger.child({
      connectionId: options.id,
      docId: options.docId,
      userId: options.auth.userId,
    });
  }

  get userId(): string | null {
    return this.auth.userId;
  }

  /** The principal this connection acts as when its access is recomputed. */
  principal(): Principal {
    return {
      userId: this.auth.userId,
      link: this.auth.linkId ? { id: this.auth.linkId } : null,
    };
  }

  send(frame: Uint8Array): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(frame);
  }

  sendControl(message: ControlMessage): void {
    this.send(encodeControl(message));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.log.info({ code, reason }, 'closing connection');
    this.socket.close(code, reason);
  }

  /** Records that the socket has closed. */
  markClosed(): void {
    this.closed = true;
  }

  /** Runs a task after every task queued before it on this connection. */
  enqueue(task: () => Promise<void>): void {
    this.chain = this.chain
      .then(() => (this.closed ? undefined : task()))
      .catch((error: unknown) => {
        this.log.error({ err: error }, 'connection task failed');
        this.close(CloseCode.ServerError, 'internal error');
      });
  }

  /** Resolves when every queued task has finished. */
  async idle(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.chain;
      await observed;
    } while (observed !== this.chain);
  }

  /** Stores freshly resolved access and tells the client when its role changed. */
  applyAccess(access: DocAccess): void {
    if (access.docEpoch < this.auth.docEpoch || access.workspaceEpoch < this.auth.workspaceEpoch) {
      return;
    }
    const previous = this.auth.role;
    this.auth = {
      ...this.auth,
      role: access.role,
      docEpoch: access.docEpoch,
      workspaceEpoch: access.workspaceEpoch,
      linkId: access.linkId,
      linkExpiresAt: access.linkExpiresAt,
    };
    if (previous === access.role) return;
    this.log.info({ from: previous, to: access.role }, 'role changed');
    this.sendControl({ type: 'role', role: access.role });
    if (!canEdit(previous) && canEdit(access.role) && this.room) {
      this.send(encodeSyncStep1(this.room.stateVector()));
    }
  }
}
