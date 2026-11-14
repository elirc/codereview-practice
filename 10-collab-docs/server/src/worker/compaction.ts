import { sql } from 'kysely';
import * as Y from 'yjs';
import { docFromLog } from '../collab/docState.js';
import { readDocLog } from '../collab/docStore.js';
import { toBytea, type Db } from '../db/db.js';
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

/**
 * Compacts one candidate document in its own transaction and reports whether
 * it was compacted, or returns null when no unlocked candidate outside `skip` remains.
 */
async function compactNext(
  options: CompactionOptions,
  skip: string[],
  now: Date,
): Promise<{ docId: string; compacted: boolean } | null> {
  return options.db.transaction().execute(async (trx) => {
    let query = trx
      .selectFrom('docs')
      .select(['id', 'head_seq', 'snapshot_seq', 'log_bytes'])
      .where('trashed_at', 'is', null)
      .where(
        sql<boolean>`(head_seq - snapshot_seq >= ${options.minUpdates} or log_bytes >= ${options.minBytes})`,
      );
    if (skip.length > 0) query = query.where('id', 'not in', skip);
    const doc = await query.orderBy('id').limit(1).forUpdate().skipLocked().executeTakeFirst();
    if (!doc) return null;
    skip.push(doc.id);
    if (!needsCompaction(doc, options)) return { docId: doc.id, compacted: false };

    const head = doc.head_seq;
    const log = await readDocLog(trx, doc.id);
    const merged = docFromLog(log, head);
    try {
      const state = Y.encodeStateAsUpdate(merged);

      await trx
        .insertInto('doc_snapshots')
        .values({ doc_id: doc.id, upto_seq: head, state: toBytea(state), created_at: now })
        .execute();
      await trx
        .deleteFrom('doc_updates')
        .where('doc_id', '=', doc.id)
        .where('seq', '<=', head)
        .execute();
      await trx
        .deleteFrom('doc_snapshots')
        .where('doc_id', '=', doc.id)
        .where('upto_seq', '<', head)
        .execute();
      await trx
        .updateTable('docs')
        .set({ snapshot_seq: head, snapshot_bytes: state.byteLength, log_bytes: 0 })
        .where('id', '=', doc.id)
        .execute();
      options.logger.info(
        { docId: doc.id, uptoSeq: head, updates: log.updates.length, bytes: state.byteLength },
        'document compacted',
      );
    } finally {
      merged.destroy();
    }
    return { docId: doc.id, compacted: true };
  });
}

/** Compacts every document over the thresholds; returns how many were compacted. */
export async function compactOnce(options: CompactionOptions, now: Date): Promise<number> {
  const skip: string[] = [];
  let compacted = 0;
  for (;;) {
    const before = skip.length;
    try {
      const outcome = await compactNext(options, skip, now);
      if (outcome === null) break;
      if (outcome.compacted) compacted += 1;
    } catch (error) {
      const docId = skip.length > before ? skip[skip.length - 1] : null;
      options.logger.error({ err: error, docId }, 'compaction failed');
      if (docId === null) throw error;
    }
  }
  return compacted;
}
