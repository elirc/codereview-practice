import { sql } from 'kysely';
import { readSnapshot, toBytea, type Db, type Tx } from '../db/db.js';
import type { Clock } from '../lib/clock.js';

export interface StoredUpdate {
  seq: number;
  update: Uint8Array;
}

export interface StoredSnapshot {
  uptoSeq: number;
  state: Uint8Array;
}

export interface DocLog {
  snapshot: StoredSnapshot | null;
  updates: StoredUpdate[];
}

export interface AppendEpochs {
  docEpoch: number;
  workspaceEpoch: number;
}

/** Decides inside the append transaction whether the update may be stored. */
export type AppendAuthorizer = (trx: Tx, epochs: AppendEpochs) => Promise<boolean>;

export interface AppendInput {
  docId: string;
  update: Uint8Array;
  userId: string | null;
  authorize?: AppendAuthorizer;
}

export type AppendStatus = 'missing' | 'forbidden' | 'too_large';

export type AppendResult = { status: 'ok'; seq: number } | { status: AppendStatus };

/** Raised inside an append transaction to roll it back with a reason. */
export class AppendRejected extends Error {
  readonly status: AppendStatus;

  constructor(status: AppendStatus) {
    super(`append rejected: ${status}`);
    this.name = 'AppendRejected';
    this.status = status;
  }
}

async function readUpdatesAfter(db: Db, docId: string, afterSeq: number): Promise<StoredUpdate[]> {
  const rows = await db
    .selectFrom('doc_updates')
    .select(['seq', 'update'])
    .where('doc_id', '=', docId)
    .where('seq', '>', afterSeq)
    .orderBy('seq', 'asc')
    .execute();
  return rows.map((row) => ({ seq: row.seq, update: row.update }));
}

async function readSnapshotAt(db: Db, docId: string, uptoSeq: number): Promise<StoredSnapshot | null> {
  const row = await db
    .selectFrom('doc_snapshots')
    .select(['upto_seq', 'state'])
    .where('doc_id', '=', docId)
    .where('upto_seq', '=', uptoSeq)
    .executeTakeFirst();
  return row ? { uptoSeq: row.upto_seq, state: row.state } : null;
}

/** Reads the newest snapshot of a document and every update after it, in seq order. */
export async function readDocLog(db: Db, docId: string): Promise<DocLog> {
  const row = await db
    .selectFrom('doc_snapshots')
    .select(['upto_seq', 'state'])
    .where('doc_id', '=', docId)
    .orderBy('upto_seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  const snapshot = row ? { uptoSeq: row.upto_seq, state: row.state } : null;
  return { snapshot, updates: await readUpdatesAfter(db, docId, snapshot?.uptoSeq ?? 0) };
}

/** Reads and persists a document's update log. */
export class DocStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly maxDocBytes: number;

  constructor(db: Db, clock: Clock, maxDocBytes: number) {
    this.db = db;
    this.clock = clock;
    this.maxDocBytes = maxDocBytes;
  }

  /** Returns the newest snapshot and the updates after it, read from one consistent snapshot. */
  load(docId: string): Promise<DocLog> {
    return readSnapshot(this.db, (trx) => readDocLog(trx, docId));
  }

  /**
   * Returns what a reader at `afterSeq` is missing: the current snapshot when
   * it is newer than `afterSeq`, then the updates after whichever is later.
   */
  readSince(docId: string, afterSeq: number): Promise<DocLog> {
    return readSnapshot(this.db, async (trx) => {
      const doc = await trx
        .selectFrom('docs')
        .select('snapshot_seq')
        .where('id', '=', docId)
        .executeTakeFirst();
      if (!doc) return { snapshot: null, updates: [] };
      const snapshot =
        doc.snapshot_seq > afterSeq ? await readSnapshotAt(trx, docId, doc.snapshot_seq) : null;
      const from = snapshot ? snapshot.uptoSeq : afterSeq;
      return { snapshot, updates: await readUpdatesAfter(trx, docId, from) };
    });
  }

  /** Returns the current head seq of each listed document that still exists. */
  async headSeqs(docIds: string[]): Promise<Map<string, number>> {
    if (docIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('docs')
      .select(['id', 'head_seq'])
      .where('id', 'in', docIds)
      .execute();
    return new Map(rows.map((row) => [row.id, row.head_seq]));
  }

  /** Returns the log together with the head seq it reaches, or null for an unknown document. */
  loadAtHead(docId: string): Promise<{ log: DocLog; headSeq: number } | null> {
    return readSnapshot(this.db, (trx) => loadAtHeadIn(trx, docId));
  }

  /** Appends one update in its own transaction and reports the outcome. */
  async append(input: AppendInput): Promise<AppendResult> {
    try {
      const seq = await this.db
        .transaction()
        .execute((trx) => this.appendInTransaction(trx, input));
      return { status: 'ok', seq };
    } catch (error) {
      if (error instanceof AppendRejected) return { status: error.status };
      throw error;
    }
  }

  /**
   * Appends one update inside the caller's transaction and returns its seq.
   * Throws `AppendRejected` when the document is gone or trashed, the
   * authorizer refuses, or the document would exceed its size limit.
   */
  async appendInTransaction(trx: Tx, input: AppendInput): Promise<number> {
    const length = input.update.byteLength;
    const doc = await trx
      .updateTable('docs')
      .set({
        head_seq: sql<number>`head_seq + 1`,
        log_bytes: sql<number>`log_bytes + ${length}`,
      })
      .where('id', '=', input.docId)
      .where('trashed_at', 'is', null)
      .returning(['head_seq', 'perm_epoch', 'workspace_id', 'snapshot_bytes', 'log_bytes'])
      .executeTakeFirst();
    if (!doc) throw new AppendRejected('missing');

    if (input.authorize) {
      const workspace = await trx
        .selectFrom('workspaces')
        .select('perm_epoch')
        .where('id', '=', doc.workspace_id)
        .executeTakeFirstOrThrow();
      const allowed = await input.authorize(trx, {
        docEpoch: doc.perm_epoch,
        workspaceEpoch: workspace.perm_epoch,
      });
      if (!allowed) throw new AppendRejected('forbidden');
    }

    if (doc.snapshot_bytes + doc.log_bytes > this.maxDocBytes) throw new AppendRejected('too_large');

    await trx
      .insertInto('doc_updates')
      .values({
        doc_id: input.docId,
        seq: doc.head_seq,
        update: toBytea(input.update),
        user_id: input.userId,
        created_at: this.clock.now(),
      })
      .execute();
    return doc.head_seq;
  }
}

/** Reads the head seq and the log up to it using the given executor. */
export async function loadAtHeadIn(
  db: Db,
  docId: string,
): Promise<{ log: DocLog; headSeq: number } | null> {
  const doc = await db
    .selectFrom('docs')
    .select('head_seq')
    .where('id', '=', docId)
    .executeTakeFirst();
  if (!doc) return null;
  const log = await readDocLog(db, docId);
  return { log, headSeq: doc.head_seq };
}
