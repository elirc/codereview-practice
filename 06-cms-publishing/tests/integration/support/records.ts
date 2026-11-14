import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { media, posts, revisionMedia, revisions, slugRedirects } from "@/db/schema";
import { createPost } from "@/services/posts";
import { saveRevision } from "@/services/revisions";
import { FIXED_NOW, type TestUser } from "./fixtures";

export async function makePost(author: TestUser, slug: string, title = "First draft") {
  return createPost({ actor: author, slug, title, now: new Date(FIXED_NOW) });
}

/** Saves a new revision through the service as `actor`, using the post's current version. */
export async function addRevision(
  actor: TestUser,
  postId: string,
  content: { title?: string; body?: string; excerpt?: string; coverMediaId?: string | null } = {},
) {
  const post = await getPost(postId);
  return saveRevision({
    actor,
    postId,
    expectedVersion: post.version,
    content: {
      title: content.title ?? "Title",
      excerpt: content.excerpt ?? "",
      body: content.body ?? `Body ${randomUUID()}`,
      coverMediaId: content.coverMediaId ?? null,
    },
    now: new Date(FIXED_NOW),
  });
}

export async function getPost(postId: string) {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId));
  return post;
}

export async function getRevisions(postId: string) {
  return db
    .select()
    .from(revisions)
    .where(eq(revisions.postId, postId))
    .orderBy(asc(revisions.number));
}

export async function getRedirects(postId: string) {
  return db.select().from(slugRedirects).where(eq(slugRedirects.postId, postId));
}

export async function getRevisionMedia(revisionId: string) {
  return db.select().from(revisionMedia).where(eq(revisionMedia.revisionId, revisionId));
}

export async function insertMediaRow(uploadedBy: string, overrides: { contentType?: string } = {}) {
  const id = randomUUID();
  const [row] = await db
    .insert(media)
    .values({
      id,
      storageKey: `media/2030/01/${id}.png`,
      originalFilename: "picture.png",
      contentType: overrides.contentType ?? "image/png",
      sizeBytes: 128,
      sha256: "0".repeat(64),
      width: 2,
      height: 2,
      uploadedBy,
      createdAt: new Date(FIXED_NOW),
    })
    .returning();
  return row;
}

/** A snapshot of everything a refused action must leave untouched. */
export async function snapshotPost(postId: string) {
  return {
    post: await getPost(postId),
    revisions: await getRevisions(postId),
    redirects: await getRedirects(postId),
  };
}
