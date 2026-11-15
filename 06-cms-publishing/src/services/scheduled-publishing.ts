import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "@/db/client";
import { posts } from "@/db/schema";
import { logger } from "@/logger";
import { DomainError } from "./errors";
import { lockPost } from "./post-guards";
import type { PublicChange } from "./posts";
import { publishScheduledInTx } from "./workflow";

export const MAX_POSTS_PER_RUN = 200;

/**
 * Publishes every post whose schedule is due, each in its own transaction. `onPublished` runs
 * after each commit. A post whose pinned revision refers to deleted media stays scheduled.
 */
export async function publishDuePosts(options: {
  now: Date;
  onPublished: (change: PublicChange) => void;
}): Promise<string[]> {
  const { now, onPublished } = options;
  const due = await db
    .select()
    .from(posts)
    .where(and(eq(posts.status, "scheduled"), lte(posts.scheduledFor, now)))
    .orderBy(asc(posts.scheduledFor))
    .limit(MAX_POSTS_PER_RUN);

  const published: string[] = [];
  for (const post of due) {
    try {
      const updated = await db.transaction(async (tx) => {
        const locked = await lockPost(tx, post.id);
        if (!locked) return null;
        return publishScheduledInTx(tx, post, now);
      });
      if (!updated) continue;
      onPublished({ id: updated.id, slugs: [updated.slug] });
      published.push(updated.id);
    } catch (err) {
      if (!(err instanceof DomainError) || err.code !== "invalid_media_reference") throw err;
      logger.warn(
        { postId: post.id, details: err.details },
        "scheduled post not published: revision refers to missing media",
      );
    }
  }

  return published;
}
