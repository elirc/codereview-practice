import type { Db } from '../db/db.js';

/** Deletes expired sessions and returns how many were removed. */
export async function purgeSessionsOnce(db: Db, now: Date): Promise<number> {
  const result = await db.deleteFrom('sessions').where('expires_at', '<=', now).executeTakeFirst();
  return Number(result.numDeletedRows);
}
