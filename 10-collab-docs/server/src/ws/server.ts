import { EventEmitter } from 'node:events';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { Config } from '../config/config.js';
import type { RoomRegistry } from '../collab/registry.js';
import type { Db } from '../db/db.js';
import { canEdit } from '../domain/roles.js';
import { TokenBucket } from '../domain/tokenBucket.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { RandomSource } from '../lib/random.js';
import type { DocAccess } from '../services/access.js';
import type { AuthSession } from '../services/auth.js';
import { CloseCode, encodeSyncStep1 } from './codec.js';
import { Connection } from './connection.js';
import { FrameHandler } from './handler.js';
import { ConnectionCounter, MAX_PAYLOAD_BYTES } from './limits.js';
import { authorizeUpgrade, rejectUpgrade } from './upgrade.js';

export interface CollabServerOptions {
  config: Config;
  db: Db;
  clock: Clock;
  random: RandomSource;
  logger: Logger;
  registry: RoomRegistry;
}

function toBytes(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Accepts document WebSocket connections and runs the connection-level loops.
 * Emits 'connection-opened' and 'connection-closed' with the connection.
 */
export class CollabServer extends EventEmitter {
  readonly connections = new Set<Connection>();
  readonly registry: RoomRegistry;
  private readonly config: Config;
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly random: RandomSource;
  private readonly wss: WebSocketServer;
  private readonly counter: ConnectionCounter;
  private readonly handler: FrameHandler;
  private readonly timers: NodeJS.Timeout[] = [];
  private accepting = true;

  constructor(options: CollabServerOptions) {
    super();
    this.config = options.config;
    this.db = options.db;
    this.clock = options.clock;
    this.random = options.random;
    this.log = options.logger;
    this.registry = options.registry;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    this.counter = new ConnectionCounter(options.config.MAX_CONNECTIONS_PER_USER_PER_DOC);
    this.handler = new FrameHandler({ config: options.config, clock: options.clock });
  }

  /** Handles WebSocket upgrades on the given HTTP server. */
  attach(server: Server): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.upgrade(request, socket, head);
    });
  }

  /** Starts the periodic loops when enabled by configuration. */
  startLoops(): void {
    if (!this.config.LOOPS_ENABLED) return;
    this.every(this.config.PING_INTERVAL_MS, 'liveness', async () => this.pingOnce());
    this.every(this.config.CATCHUP_INTERVAL_MS, 'catch-up', () => this.registry.catchUpStale());
    const idleSweepMs = Math.max(1_000, Math.min(this.config.ROOM_IDLE_MS, 5_000));
    this.every(idleSweepMs, 'idle rooms', async () => {
      await this.registry.sweepIdle(this.clock.now());
    });
  }

  private every(intervalMs: number, name: string, run: () => Promise<void>): void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      run()
        .catch((error: unknown) => this.log.error({ err: error, loop: name }, 'loop failed'))
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref();
    this.timers.push(timer);
  }

  /** Pings every connection and terminates those that did not answer the previous ping. */
  pingOnce(): void {
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.log.info('terminating unresponsive connection');
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }

  /** Stops accepting new upgrades. */
  stopAccepting(): void {
    this.accepting = false;
  }

  /**
   * Stops accepting upgrades, lets every connection and room finish its
   * queued work, then closes all sockets with 1001 and closes the rooms.
   */
  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    for (const conn of this.connections) conn.draining = true;
    await Promise.all([...this.connections].map((conn) => conn.idle()));
    await this.registry.drainAll();
    for (const conn of [...this.connections]) conn.close(CloseCode.GoingAway, 'server shutting down');
    await this.registry.closeAll();
    this.wss.close();
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const onError = () => socket.destroy();
    socket.on('error', onError);
    try {
      if (!this.accepting) return rejectUpgrade(socket, 503);
      const decision = await authorizeUpgrade(request, {
        db: this.db,
        appOrigin: this.config.APP_ORIGIN,
        now: this.clock.now(),
      });
      if (!decision.ok) return rejectUpgrade(socket, decision.status);
      if (!this.accepting) return rejectUpgrade(socket, 503);
      const userId = decision.session?.user.id ?? null;
      const docId = decision.access.docId;
      if (userId !== null && !this.counter.tryAcquire(docId, userId)) {
        return rejectUpgrade(socket, 429);
      }
      if (socket.destroyed) {
        if (userId !== null) this.counter.release(docId, userId);
        return;
      }
      socket.off('error', onError);
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.open(ws, decision.session, decision.access);
      });
    } catch (error) {
      this.log.error({ err: error }, 'upgrade failed');
      rejectUpgrade(socket, 500);
    }
  }

  private open(socket: WebSocket, session: AuthSession | null, access: DocAccess): void {
    const conn = new Connection({
      id: this.random.uuid(),
      docId: access.docId,
      workspaceId: access.workspaceId,
      socket,
      bucket: new TokenBucket(
        this.config.WS_RATE_PER_SEC,
        this.config.WS_RATE_BURST,
        this.clock.now().getTime(),
      ),
      logger: this.log,
      auth: {
        userId: session?.user.id ?? null,
        userName: session?.user.name ?? null,
        sessionId: session?.sessionId ?? null,
        sessionExpiresAt: session?.expiresAt ?? null,
        linkId: access.linkId,
        linkExpiresAt: access.linkExpiresAt,
        role: access.role,
        docEpoch: access.docEpoch,
        workspaceEpoch: access.workspaceEpoch,
      },
    });
    this.connections.add(conn);
    conn.log.info({ role: access.role }, 'connection opened');
    this.emit('connection-opened', conn);

    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (conn.closed) return;
      if (conn.draining) {
        conn.close(CloseCode.GoingAway, 'server shutting down');
        return;
      }
      if (!conn.bucket.take(this.clock.now().getTime())) {
        conn.close(CloseCode.RateLimited, 'rate limited');
        return;
      }
      const bytes = toBytes(data);
      conn.enqueue(() => this.handler.handle(conn, bytes, isBinary));
    });
    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('error', (error: Error) => conn.log.warn({ err: error }, 'socket error'));
    socket.on('close', (code: number) => this.closed(conn, code));

    conn.enqueue(() => this.join(conn));
  }

  private async join(conn: Connection): Promise<void> {
    const room = await this.registry.acquire(conn.docId, conn.workspaceId);
    if (conn.closed) {
      this.registry.cancelJoin(room, this.clock.now());
      return;
    }
    this.registry.attach(room, conn);
    conn.room = room;
    conn.sendControl({
      type: 'hello',
      role: conn.auth.role,
      connectionId: conn.id,
      userId: conn.auth.userId,
    });
    if (canEdit(conn.auth.role)) conn.send(encodeSyncStep1(room.stateVector()));
    const presence = room.awarenessFrame();
    if (presence) conn.send(presence);
  }

  /** Cleans up after a socket closes. */
  private closed(conn: Connection, code: number): void {
    conn.markClosed();
    this.connections.delete(conn);
    if (conn.auth.userId !== null) this.counter.release(conn.docId, conn.auth.userId);
    if (conn.room) {
      if (conn.awarenessClientId !== null) {
        conn.room.removeAwareness(conn.awarenessClientId, conn.awarenessClock);
      }
      this.registry.detach(conn.room, conn, this.clock.now());
    }
    conn.log.info({ code }, 'connection closed');
    this.emit('connection-closed', conn);
  }
}
