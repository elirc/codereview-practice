import { sql } from 'kysely';
import * as Y from 'yjs';
import { docFromLog } from '../collab/docState.js';
import { loadAtHeadIn } from '../collab/docStore.js';
import { readSnapshot, toBytea, type Db } from '../db/db.js';
import type { Logger } from '../lib/logger.js';

export interface CompactionOptions {
  db: Db;
  logger: Logger;
  minUpdates: number;
  minBytes: number;
}

/** Returns whether a document's log is long enough to compact. */
export function needsCompaction(
  doc: { head_seq: number; snapshot_seq: number; log_bytes: number },
  options: Pick<CompactionOptions, 'minUpdates' | 'minBytes'>,
): boolean {
  return doc.head_seq - doc.snapshot_seq >= options.minUpdates || doc.log_bytes >= options.minBytes;
}

/** Lists the untrashed documents over the compaction thresholds. */
async function candidates(options: CompactionOptions): Promise<string[]> {
  const rows = await options.db
    .selectFrom('docs')
    .select('id')
    .where('trashed_at', 'is', null)
    .where(
      sql<boolean>`(head_seq - snapshot_seq >= ${options.minUpdates} or log_bytes >= ${options.minBytes})`,
    )
    .orderBy('id')
    .execute();
  return rows.map((row) => row.id);
}

/** Builds a document's full state at its head from one consistent read, or null if it is gone. */
async function mergedState(
  db: Db,
  docId: string,
): Promise<{ head: number; state: Uint8Array; updates: number } | null> {
  const loaded = await readSnapshot(db, (trx) => loadAtHeadIn(trx, docId));
  if (!loaded) return null;
  const merged = docFromLog(loaded.log, loaded.headSeq);
  try {
    return {
      head: loaded.headSeq,
      state: Y.encodeStateAsUpdate(merged),
      updates: loaded.log.updates.length,
    };
  } finally {
    merged.destroy();
  }
}

/**
 * Compacts one document: builds the merged state first, then stores it as
 * the document's snapshot in a short transaction. Returns false when the
 * document is locked, trashed, below the thresholds or already compacted.
 */
async function compactDoc(options: CompactionOptions, docId: string, now: Date): Promise<boolean> {
  const built = await mergedState(options.db, docId);
  if (!built) return false;
  const { head, state } = built;

  return options.db.transaction().execute(async (trx) => {
    const doc = await trx
      .selectFrom('docs')
      .select(['head_seq', 'snapshot_seq', 'log_bytes', 'trashed_at'])
      .where('id', '=', docId)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!doc || doc.trashed_at !== null || doc.snapshot_seq >= head) return false;
    if (!needsCompaction(doc, options)) return false;

    await trx
      .insertInto('doc_snapshots')
      .values({ doc_id: docId, upto_seq: head, state: toBytea(state), created_at: now })
      .execute();
    await trx
      .deleteFrom('doc_updates')
      .where('doc_id', '=', docId)
      .where('seq', '<=', doc.head_seq)
      .execute();
    await trx
      .deleteFrom('doc_snapshots')
      .where('doc_id', '=', docId)
      .where('upto_seq', '<', head)
      .execute();
    await trx
      .updateTable('docs')
      .set({ snapshot_seq: head, snapshot_bytes: state.byteLength, log_bytes: 0 })
      .where('id', '=', docId)
      .execute();
    options.logger.info(
      { docId, uptoSeq: head, updates: built.updates, bytes: state.byteLength },
      'document compacted',
    );
    return true;
  });
}

/** Compacts every document over the thresholds; returns how many were compacted. */
export async function compactOnce(options: CompactionOptions, now: Date): Promise<number> {
  let compacted = 0;
  for (const docId of await candidates(options)) {
    try {
      if (await compactDoc(options, docId, now)) compacted += 1;
    } catch (error) {
      options.logger.error({ err: error, docId }, 'compaction failed');
    }
  }
  return compacted;
}
