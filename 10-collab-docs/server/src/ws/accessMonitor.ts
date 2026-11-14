import type { AccessListener } from '../collab/registry.js';
import type { Db } from '../db/db.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import { resolveDocAccess } from '../services/access.js';
import { CloseCode } from './codec.js';
import type { Connection } from './connection.js';

export interface AccessMonitorOptions {
  db: Db;
  clock: Clock;
  connections: Set<Connection>;
  logger: Logger;
}

/** Re-evaluates open connections against current database state. */
export class AccessMonitor implements AccessListener {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly connections: Set<Connection>;
  private readonly log: Logger;

  constructor(options: AccessMonitorOptions) {
    this.db = options.db;
    this.clock = options.clock;
    this.connections = options.connections;
    this.log = options.logger;
  }

  docPermChanged(docId: string): void {
    void this.reevaluateWhere((conn) => conn.docId === docId);
  }

  workspacePermChanged(workspaceId: string): void {
    void this.reevaluateWhere((conn) => conn.workspaceId === workspaceId);
  }

  sessionEnded(sessionId: string): void {
    for (const conn of this.open()) {
      if (conn.auth.sessionId === sessionId) conn.close(CloseCode.SessionEnded, 'session ended');
    }
  }

  /** Recomputes one connection's access and closes it or updates its role. */
  async reevaluate(conn: Connection): Promise<void> {
    if (conn.closed) return;
    const now = this.clock.now();
    if (conn.auth.sessionId !== null) {
      const session = await this.db
        .selectFrom('sessions')
        .select('id')
        .where('id', '=', conn.auth.sessionId)
        .where('expires_at', '>', now)
        .executeTakeFirst();
      if (!session) {
        conn.close(CloseCode.SessionEnded, 'session ended');
        return;
      }
    }
    const result = await resolveDocAccess(this.db, conn.docId, conn.principal(), now);
    if (conn.closed) return;
    switch (result.kind) {
      case 'missing':
      case 'trashed':
        conn.close(CloseCode.Gone, 'document unavailable');
        return;
      case 'none':
        conn.close(CloseCode.Forbidden, 'access lost');
        return;
      case 'ok':
        conn.applyAccess(result.access);
        return;
    }
  }

  /**
   * Checks every open connection: documents gone or trashed, sessions ended
   * or expired, expired links, and stored epochs that no longer match.
   */
  async sweep(now: Date): Promise<void> {
    const conns = this.open().filter((conn) => conn.room !== null);
    if (conns.length === 0) return;

    const docIds = [...new Set(conns.map((conn) => conn.docId))];
    const docs = await this.db
      .selectFrom('docs')
      .innerJoin('workspaces', 'workspaces.id', 'docs.workspace_id')
      .select([
        'docs.id',
        'docs.perm_epoch',
        'docs.trashed_at',
        'workspaces.perm_epoch as workspace_epoch',
      ])
      .where('docs.id', 'in', docIds)
      .execute();
    const byId = new Map(docs.map((doc) => [doc.id, doc]));

    const sessionIds = [
      ...new Set(conns.map((conn) => conn.auth.sessionId).filter((id): id is string => id !== null)),
    ];
    const live =
      sessionIds.length === 0
        ? new Set<string>()
        : new Set(
            (
              await this.db
                .selectFrom('sessions')
                .select('id')
                .where('id', 'in', sessionIds)
                .where('expires_at', '>', now)
                .execute()
            ).map((row) => row.id),
          );

    const changed: Connection[] = [];
    for (const conn of conns) {
      const doc = byId.get(conn.docId);
      if (!doc || doc.trashed_at !== null) {
        conn.close(CloseCode.Gone, 'document unavailable');
        continue;
      }
      if (conn.auth.sessionId !== null && !live.has(conn.auth.sessionId)) {
        conn.close(CloseCode.SessionEnded, 'session ended');
        continue;
      }
      const linkExpired =
        conn.auth.linkExpiresAt !== null && now.getTime() >= conn.auth.linkExpiresAt.getTime();
      if (
        linkExpired ||
        doc.perm_epoch !== conn.auth.docEpoch ||
        doc.workspace_epoch !== conn.auth.workspaceEpoch
      ) {
        changed.push(conn);
      }
    }
    await Promise.all(changed.map((conn) => this.reevaluate(conn)));
  }

  private open(): Connection[] {
    return [...this.connections].filter((conn) => !conn.closed);
  }

  private async reevaluateWhere(predicate: (conn: Connection) => boolean): Promise<void> {
    const affected = this.open().filter(predicate);
    await Promise.all(
      affected.map((conn) =>
        this.reevaluate(conn).catch((error: unknown) =>
          conn.log.error({ err: error }, 'access re-evaluation failed'),
        ),
      ),
    );
  }
}
