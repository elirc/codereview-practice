import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "@/auth/policy";
import { db, type Executor } from "@/db/client";
import {
  media,
  posts,
  revisionMedia,
  revisions,
  users,
  type Post,
  type Revision,
} from "@/db/schema";
import { lineDiff, type DiffLine } from "./diff";
import { DomainError, notFoundError } from "./errors";
import { extractMediaIds } from "./media-references";
import { assertExpectedVersion, lockPostFor } from "./post-guards";
import { getPostForActor } from "./posts";

export type RevisionContent = {
  title: string;
  excerpt: string;
  body: string;
  coverMediaId: string | null;
};

export type SaveOutcome = { post: Post; revision: Revision; created: boolean };

function hasSameContent(revision: Revision, content: RevisionContent): boolean {
  return (
    revision.title === content.title &&
    revision.excerpt === content.excerpt &&
    revision.body === content.body &&
    revision.coverMediaId === content.coverMediaId
  );
}

/** Returns the media ids referenced by the body and cover; throws if any does not exist. */
export async function lockReferencedMedia(
  tx: Executor,
  content: Pick<RevisionContent, "body" | "coverMediaId">,
): Promise<string[]> {
  const ids = extractMediaIds(content.body, content.coverMediaId);
  if (ids.length === 0) return ids;

  const found = await tx
    .select({ id: media.id })
    .from(media)
    .where(inArray(media.id, ids))
    .for("key share");
  const foundIds = new Set(found.map((row) => row.id));
  const missing = ids.filter((mediaId) => !foundIds.has(mediaId));
  if (missing.length > 0) {
    throw new DomainError(
      "invalid_media_reference",
      "The post refers to media that does not exist.",
      { missing },
    );
  }
  return ids;
}

async function appendRevision(
  tx: Executor,
  post: Post,
  content: RevisionContent,
  actor: Actor,
  now: Date,
  restoredFromNumber: number | null,
): Promise<{ post: Post; revision: Revision }> {
  const mediaIds = await lockReferencedMedia(tx, content);

  const [{ maxNumber }] = await tx
    .select({ maxNumber: sql<number>`coalesce(max(${revisions.number}), 0)::int` })
    .from(revisions)
    .where(eq(revisions.postId, post.id));

  const [revision] = await tx
    .insert(revisions)
    .values({
      postId: post.id,
      number: maxNumber + 1,
      title: content.title,
      excerpt: content.excerpt,
      body: content.body,
      coverMediaId: content.coverMediaId,
      createdBy: actor.id,
      createdAt: now,
      restoredFromNumber,
    })
    .returning();

  if (mediaIds.length > 0) {
    await tx
      .insert(revisionMedia)
      .values(mediaIds.map((mediaId) => ({ revisionId: revision.id, mediaId })));
  }

  const [updated] = await tx
    .update(posts)
    .set({ latestRevisionId: revision.id, version: post.version + 1, updatedAt: now })
    .where(eq(posts.id, post.id))
    .returning();

  return { post: updated, revision };
}

/** Saves content as a new revision. Content identical to the latest revision is a no-op. */
export async function saveRevision(input: {
  actor: Actor;
  postId: string;
  expectedVersion: number;
  content: RevisionContent;
  now: Date;
}): Promise<SaveOutcome> {
  const { actor, postId, expectedVersion, content, now } = input;
  return db.transaction(async (tx) => {
    const post = await lockPostFor(tx, actor, postId, "editContent");
    await assertExpectedVersion(tx, post, expectedVersion);

    if (post.latestRevisionId) {
      const [latest] = await tx
        .select()
        .from(revisions)
        .where(eq(revisions.id, post.latestRevisionId));
      if (latest && hasSameContent(latest, content)) {
        return { post, revision: latest, created: false };
      }
    }

    const appended = await appendRevision(tx, post, content, actor, now, null);
    return { ...appended, created: true };
  });
}

/** Creates a new revision that copies an earlier one. Publishing state is left alone. */
export async function restoreRevision(input: {
  actor: Actor;
  postId: string;
  revisionId: string;
  expectedVersion: number;
  now: Date;
}): Promise<SaveOutcome> {
  const { actor, postId, revisionId, expectedVersion, now } = input;
  return db.transaction(async (tx) => {
    const post = await lockPostFor(tx, actor, postId, "editContent");
    await assertExpectedVersion(tx, post, expectedVersion);

    const [source] = await tx
      .select()
      .from(revisions)
      .where(and(eq(revisions.id, revisionId), eq(revisions.postId, post.id)));
    if (!source) {
      throw new DomainError("invalid_revision", "That revision does not belong to this post.");
    }

    const content: RevisionContent = {
      title: source.title,
      excerpt: source.excerpt,
      body: source.body,
      coverMediaId: source.coverMediaId,
    };
    const appended = await appendRevision(tx, post, content, actor, now, source.number);
    return { ...appended, created: true };
  });
}

export type RevisionListItem = Revision & { createdByName: string };

export async function listRevisions(actor: Actor, postId: string): Promise<RevisionListItem[]> {
  await getPostForActor(actor, postId);
  const rows = await db
    .select({ revision: revisions, createdByName: users.name })
    .from(revisions)
    .innerJoin(users, eq(users.id, revisions.createdBy))
    .where(eq(revisions.postId, postId))
    .orderBy(desc(revisions.number));
  return rows.map((row) => ({ ...row.revision, createdByName: row.createdByName }));
}

/** A revision of a post the actor may view, or `not_found`. */
export async function getRevisionForActor(
  actor: Actor,
  postId: string,
  revisionId: string,
): Promise<{ post: Post; revision: Revision }> {
  const post = await getPostForActor(actor, postId);
  const [revision] = await db
    .select()
    .from(revisions)
    .where(and(eq(revisions.id, revisionId), eq(revisions.postId, post.id)));
  if (!revision) throw notFoundError("Revision not found.");
  return { post, revision };
}

export async function diffRevisions(
  actor: Actor,
  postId: string,
  fromRevisionId: string,
  toRevisionId: string,
): Promise<{ from: Revision; to: Revision; lines: DiffLine[] }> {
  const { revision: from } = await getRevisionForActor(actor, postId, fromRevisionId);
  const { revision: to } = await getRevisionForActor(actor, postId, toRevisionId);
  return { from, to, lines: lineDiff(from.body, to.body) };
}
