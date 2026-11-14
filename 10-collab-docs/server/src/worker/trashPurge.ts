import type { Db } from '../db/db.js';
import { addDays } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';

export const PURGE_BATCH_SIZE = 50;

export interface TrashPurgeOptions {
  db: Db;
  logger: Logger;
  retentionDays: number;
}

/**
 * Permanently deletes documents trashed more than the retention period ago,
 * with their log, snapshots, versions, comments, shares and links, in batches.
 * Returns how many documents were deleted.
 */
export async function purgeTrashOnce(options: TrashPurgeOptions, now: Date): Promise<number> {
  const cutoff = addDays(now, -options.retentionDays);
  let purged = 0;
  for (;;) {
    const ids = await options.db.transaction().execute(async (trx) => {
      const batch = await trx
        .selectFrom('docs')
        .select('id')
        .where('trashed_at', '<', cutoff)
        .orderBy('trashed_at')
        .limit(PURGE_BATCH_SIZE)
        .forUpdate()
        .skipLocked()
        .execute();
      const docIds = batch.map((row) => row.id);
      if (docIds.length > 0) await trx.deleteFrom('docs').where('id', 'in', docIds).execute();
      return docIds;
    });
    purged += ids.length;
    if (ids.length > 0) options.logger.info({ count: ids.length }, 'trashed documents purged');
    if (ids.length < PURGE_BATCH_SIZE) break;
  }
  return purged;
}
