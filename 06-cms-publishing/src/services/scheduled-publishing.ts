import { and, asc, eq, lte, notInArray } from "drizzle-orm";
import { db } from "@/db/client";
import { posts } from "@/db/schema";
import { logger } from "@/logger";
import { DomainError } from "./errors";
import type { PublicChange } from "./posts";
import { publishScheduledInTx } from "./workflow";

export const BATCH_SIZE = 20;
export const MAX_POSTS_PER_RUN = 200;

/**
 * Publishes every post whose schedule is due, in batches of one transaction each.
 * `onBatchCommitted` runs after each batch commits with the posts it published. A post whose
 * pinned revision refers to deleted media stays scheduled and is skipped for this run.
 */
export async function publishDuePosts(options: {
  now: Date;
  onBatchCommitted: (changes: PublicChange[]) => void;
}): Promise<string[]> {
  const { now, onBatchCommitted } = options;
  const published: string[] = [];
  const skipped: string[] = [];

  while (published.length + skipped.length < MAX_POSTS_PER_RUN) {
    const limit = Math.min(BATCH_SIZE, MAX_POSTS_PER_RUN - published.length - skipped.length);
    const { changes, selected } = await db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(posts)
        .where(
          and(
            eq(posts.status, "scheduled"),
            lte(posts.scheduledFor, now),
            skipped.length > 0 ? notInArray(posts.id, skipped) : undefined,
          ),
        )
        .orderBy(asc(posts.scheduledFor))
        .limit(limit)
        .for("update", { skipLocked: true });

      const batchChanges: PublicChange[] = [];
      for (const post of due) {
        try {
          const updated = await publishScheduledInTx(tx, post, now);
          batchChanges.push({ id: updated.id, slugs: [updated.slug] });
        } catch (err) {
          if (!(err instanceof DomainError) || err.code !== "invalid_media_reference") throw err;
          logger.warn(
            { postId: post.id, details: err.details },
            "scheduled post not published: revision refers to missing media",
          );
          skipped.push(post.id);
        }
      }
      return { changes: batchChanges, selected: due.length };
    });

    if (changes.length > 0) {
      onBatchCommitted(changes);
      published.push(...changes.map((change) => change.id));
    }
    if (selected < limit) break;
  }

  return published;
}
