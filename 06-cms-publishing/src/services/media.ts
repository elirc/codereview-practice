import { desc, eq, or } from "drizzle-orm";
import { assertCanDeleteMedia, type Actor } from "@/auth/policy";
import { db, type Executor } from "@/db/client";
import { media, posts, revisionMedia, users, type Media, type NewMedia } from "@/db/schema";
import { logger } from "@/logger";
import type { MediaStorage } from "@/media/storage";
import { notFoundError } from "./errors";

export type MediaUsage = { referencedByAnyRevision: boolean; referencedByLiveRevision: boolean };

const liveRevisionJoin = or(
  eq(posts.publishedRevisionId, revisionMedia.revisionId),
  eq(posts.scheduledRevisionId, revisionMedia.revisionId),
);

export async function insertMedia(values: NewMedia): Promise<Media> {
  const [row] = await db.insert(media).values(values).returning();
  return row;
}

export async function findMediaById(mediaId: string): Promise<Media | null> {
  const [row] = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
  return row ?? null;
}

/** True when the media is referenced by a revision that some post currently publishes. */
export async function isMediaPublic(mediaId: string): Promise<boolean> {
  const [row] = await db
    .select({ postId: posts.id })
    .from(revisionMedia)
    .innerJoin(posts, eq(posts.publishedRevisionId, revisionMedia.revisionId))
    .where(eq(revisionMedia.mediaId, mediaId))
    .limit(1);
  return row !== undefined;
}

async function mediaUsage(executor: Executor, mediaId: string): Promise<MediaUsage> {
  const [anyReference] = await executor
    .select({ revisionId: revisionMedia.revisionId })
    .from(revisionMedia)
    .where(eq(revisionMedia.mediaId, mediaId))
    .limit(1);
  const [liveReference] = await executor
    .select({ postId: posts.id })
    .from(revisionMedia)
    .innerJoin(posts, liveRevisionJoin)
    .where(eq(revisionMedia.mediaId, mediaId))
    .limit(1);
  return {
    referencedByAnyRevision: anyReference !== undefined,
    referencedByLiveRevision: liveReference !== undefined,
  };
}

export type MediaLibraryItem = Media & { uploaderName: string } & MediaUsage;

export async function listMediaLibrary(): Promise<MediaLibraryItem[]> {
  const rows = await db
    .select({ media, uploaderName: users.name })
    .from(media)
    .innerJoin(users, eq(users.id, media.uploadedBy))
    .orderBy(desc(media.createdAt))
    .limit(500);

  const referenced = await db.selectDistinct({ id: revisionMedia.mediaId }).from(revisionMedia);
  const live = await db
    .selectDistinct({ id: revisionMedia.mediaId })
    .from(revisionMedia)
    .innerJoin(posts, liveRevisionJoin);
  const referencedIds = new Set(referenced.map((row) => row.id));
  const liveIds = new Set(live.map((row) => row.id));

  return rows.map((row) => ({
    ...row.media,
    uploaderName: row.uploaderName,
    referencedByAnyRevision: referencedIds.has(row.media.id),
    referencedByLiveRevision: liveIds.has(row.media.id),
  }));
}

/**
 * Deletes a media row after checking the policy against its current references, then removes
 * the stored object. Object removal happens after commit and failures are only logged.
 */
export async function deleteMedia(input: {
  actor: Actor;
  mediaId: string;
  storage: MediaStorage;
}): Promise<Media> {
  const { actor, mediaId, storage } = input;
  const deleted = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(media).where(eq(media.id, mediaId)).for("update");
    if (!row) throw notFoundError("Media not found.");
    const usage = await mediaUsage(tx, row.id);
    assertCanDeleteMedia(actor, { uploadedBy: row.uploadedBy, ...usage });
    await tx.delete(media).where(eq(media.id, row.id));
    return row;
  });

  try {
    await storage.delete(deleted.storageKey);
  } catch (err) {
    logger.warn({ err, storageKey: deleted.storageKey }, "could not remove deleted media object");
  }
  return deleted;
}
