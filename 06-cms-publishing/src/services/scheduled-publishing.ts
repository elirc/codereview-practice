import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "@/db/client";
import { posts } from "@/db/schema";
import type { PublicChange } from "./posts";
import { publishScheduledInTx } from "./workflow";

export const BATCH_SIZE = 20;
export const MAX_POSTS_PER_RUN = 200;

/**
 * Publishes every post whose schedule is due, in batches of one transaction each.
 * `onBatchCommitted` runs after each batch commits with the posts it published.
 */
export async function publishDuePosts(options: {
  now: Date;
  onBatchCommitted: (changes: PublicChange[]) => void;
}): Promise<string[]> {
  const { now, onBatchCommitted } = options;
  const published: string[] = [];

  while (published.length < MAX_POSTS_PER_RUN) {
    const limit = Math.min(BATCH_SIZE, MAX_POSTS_PER_RUN - published.length);
    const batch = await db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(posts)
        .where(and(eq(posts.status, "scheduled"), lte(posts.scheduledFor, now)))
        .orderBy(asc(posts.scheduledFor))
        .limit(limit)
        .for("update", { skipLocked: true });

      const changes: PublicChange[] = [];
      for (const post of due) {
        const updated = await publishScheduledInTx(tx, post, now);
        changes.push({ id: updated.id, slugs: [updated.slug] });
      }
      return changes;
    });

    if (batch.length === 0) break;
    onBatchCommitted(batch);
    published.push(...batch.map((change) => change.id));
    if (batch.length < limit) break;
  }

  return published;
}
