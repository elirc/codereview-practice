import * as Y from 'yjs';
import type { Config } from '../config/config.js';
import type { AppendAuthorizer } from '../collab/docStore.js';
import type { Room } from '../collab/room.js';
import { filterAwarenessUpdate } from '../collab/awarenessFilter.js';
import { addsNothing } from '../collab/updates.js';
import { canEdit, canSendPresence } from '../domain/roles.js';
import type { Clock } from '../lib/clock.js';
import { resolveDocAccess } from '../services/access.js';
import { CloseCode, decodeFrame, encodeSyncStep2, ProtocolError, type Frame } from './codec.js';
import type { Connection } from './connection.js';

export interface FrameHandlerOptions {
  config: Config;
  clock: Clock;
}

/** Processes inbound frames for joined connections. */
export class FrameHandler {
  private readonly config: Config;
  private readonly clock: Clock;

  constructor(options: FrameHandlerOptions) {
    this.config = options.config;
    this.clock = options.clock;
  }

  /** Handles one inbound frame that has already passed the rate limit. */
  async handle(conn: Connection, data: Uint8Array, isBinary: boolean): Promise<void> {
    const room = conn.room;
    if (conn.closed || !room) return;
    const now = this.clock.now();
    if (conn.auth.sessionExpiresAt && now.getTime() >= conn.auth.sessionExpiresAt.getTime()) {
      conn.close(CloseCode.SessionEnded, 'session expired');
      return;
    }

    if (!isBinary) {
      conn.close(CloseCode.Malformed, 'binary frames only');
      return;
    }
    let frame: Frame;
    try {
      frame = decodeFrame(data);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      conn.close(CloseCode.Malformed, error.message);
      return;
    }

    switch (frame.type) {
      case 'sync-step1':
        this.answerStateVector(conn, room, frame.stateVector);
        return;
      case 'sync-step2':
      case 'sync-update':
        await this.receiveUpdate(conn, room, frame.update);
        return;
      case 'awareness':
        this.receiveAwareness(conn, room, frame.update);
        return;
      case 'control':
        conn.close(CloseCode.Malformed, 'control frames are server-only');
        return;
    }
  }

  private answerStateVector(conn: Connection, room: Room, stateVector: Uint8Array): void {
    let update: Uint8Array;
    try {
      update = Y.encodeStateAsUpdate(room.doc, stateVector);
    } catch {
      conn.close(CloseCode.Malformed, 'invalid state vector');
      return;
    }
    conn.send(encodeSyncStep2(update));
  }

  private async receiveUpdate(conn: Connection, room: Room, update: Uint8Array): Promise<void> {
    if (!canEdit(conn.auth.role)) {
      conn.close(CloseCode.Forbidden, 'read-only connection');
      return;
    }
    if (update.byteLength > this.config.MAX_UPDATE_BYTES) {
      conn.close(CloseCode.TooLarge, 'update too large');
      return;
    }
    let unchanged: boolean;
    try {
      Y.decodeUpdate(update);
      unchanged = addsNothing(update, room.doc);
    } catch {
      conn.close(CloseCode.Malformed, 'malformed update');
      return;
    }
    if (unchanged) return;

    const result = await room.appendFromPeer(conn, update, this.authorizer(conn));
    switch (result.status) {
      case 'ok':
        return;
      case 'missing':
        conn.close(CloseCode.Gone, 'document unavailable');
        return;
      case 'forbidden':
        conn.close(CloseCode.Forbidden, 'access lost');
        return;
      case 'too_large':
        conn.close(CloseCode.TooLarge, 'document size limit reached');
        return;
    }
  }

  private receiveAwareness(conn: Connection, room: Room, update: Uint8Array): void {
    const userId = conn.auth.userId;
    if (userId === null || !canSendPresence(conn.auth.role, true)) {
      conn.close(CloseCode.Forbidden, 'presence not allowed');
      return;
    }
    const result = filterAwarenessUpdate(update, {
      pinnedClientId: conn.awarenessClientId,
      user: { id: userId, name: conn.auth.userName ?? '' },
    });
    if (!result.ok) {
      conn.close(result.code, result.reason);
      return;
    }
    if (conn.awarenessClientId === null) {
      if (room.awarenessClientTaken(result.clientId, conn)) {
        conn.close(CloseCode.Forbidden, 'awareness client id not allowed');
        return;
      }
      conn.awarenessClientId = result.clientId;
    }
    conn.awarenessClock = Math.max(conn.awarenessClock, result.clock);
    room.applyPeerAwareness(conn, result.update);
  }

  private authorizer(conn: Connection): AppendAuthorizer {
    return async (trx, epochs) => {
      if (epochs.docEpoch === conn.auth.docEpoch && epochs.workspaceEpoch === conn.auth.workspaceEpoch) {
        return true;
      }
      const result = await resolveDocAccess(trx, conn.docId, conn.principal(), this.clock.now());
      if (result.kind !== 'ok') return false;
      conn.applyAccess(result.access);
      return canEdit(result.access.role);
    };
  }
}
