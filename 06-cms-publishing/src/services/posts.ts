import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { authorizePost, canOnPost, type Actor } from "@/auth/policy";
import { db, type Executor } from "@/db/client";
import {
  posts,
  revisionMedia,
  revisions,
  slugRedirects,
  users,
  type Post,
  type PostStatus,
} from "@/db/schema";
import { notFoundError } from "./errors";
import { assertMediaExists } from "./media";
import { extractMediaIds } from "./media-references";
import { assertExpectedVersion, lockPostFor } from "./post-guards";
import type { RevisionContent } from "./revisions";
import { assertSlugAvailable, lockSlugs } from "./slugs";

/** Identifies public content that changed: the post and every slug whose page may differ. */
export type PublicChange = { id: string; slugs: string[] };

export type PostState = Pick<
  Post,
  | "id"
  | "slug"
  | "status"
  | "version"
  | "latestRevisionId"
  | "publishedRevisionId"
  | "scheduledRevisionId"
  | "scheduledFor"
  | "publishedAt"
  | "firstPublishedAt"
>;

export function toPostState(post: Post): PostState {
  return {
    id: post.id,
    slug: post.slug,
    status: post.status,
    version: post.version,
    latestRevisionId: post.latestRevisionId,
    publishedRevisionId: post.publishedRevisionId,
    scheduledRevisionId: post.scheduledRevisionId,
    scheduledFor: post.scheduledFor,
    publishedAt: post.publishedAt,
    firstPublishedAt: post.firstPublishedAt,
  };
}

/** Inserts a draft post owned by `authorId` whose first revision holds `content`. */
async function insertDraft(
  tx: Executor,
  values: { slug: string; authorId: string; content: RevisionContent; now: Date },
): Promise<Post> {
  const { slug, authorId, content, now } = values;
  await lockSlugs(tx, [slug]);
  await assertSlugAvailable(tx, slug, null);
  const mediaIds = extractMediaIds(content.body, content.coverMediaId);
  await assertMediaExists(tx, mediaIds);

  const [post] = await tx
    .insert(posts)
    .values({ slug, authorId, status: "draft", createdAt: now, updatedAt: now })
    .returning();
  const [revision] = await tx
    .insert(revisions)
    .values({ postId: post.id, number: 1, ...content, createdBy: authorId, createdAt: now })
    .returning();
  if (mediaIds.length > 0) {
    await tx
      .insert(revisionMedia)
      .values(mediaIds.map((mediaId) => ({ revisionId: revision.id, mediaId })));
  }
  const [withRevision] = await tx
    .update(posts)
    .set({ latestRevisionId: revision.id })
    .where(eq(posts.id, post.id))
    .returning();
  return withRevision;
}

/** Creates a draft post together with its first revision. */
export async function createPost(input: {
  actor: Actor;
  slug: string;
  title: string;
  now: Date;
}): Promise<Post> {
  const { actor, slug, title, now } = input;
  return db.transaction((tx) =>
    insertDraft(tx, {
      slug,
      authorId: actor.id,
      content: { title, excerpt: "", body: "", coverMediaId: null },
      now,
    }),
  );
}

/** Creates a new draft owned by the actor that starts from another post's latest revision. */
export async function duplicatePost(input: {
  actor: Actor;
  sourcePostId: string;
  slug: string;
  now: Date;
}): Promise<Post> {
  const { actor, sourcePostId, slug, now } = input;
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select({
        title: revisions.title,
        excerpt: revisions.excerpt,
        body: revisions.body,
        coverMediaId: revisions.coverMediaId,
      })
      .from(posts)
      .innerJoin(revisions, eq(revisions.id, posts.latestRevisionId))
      .where(eq(posts.id, sourcePostId))
      .limit(1);
    if (!source) throw notFoundError("Post not found.");

    return insertDraft(tx, { slug, authorId: actor.id, content: source, now });
  });
}

/**
 * Moves a post to a new slug. Once a post has been published its old slug keeps working as a
 * redirect; moving back onto one of the post's own redirects removes that redirect.
 */
export async function changeSlug(input: {
  actor: Actor;
  postId: string;
  expectedVersion: number;
  slug: string;
  now: Date;
}): Promise<{ post: Post; publicChange: PublicChange | null }> {
  const { actor, postId, expectedVersion, slug, now } = input;
  return db.transaction(async (tx) => {
    const post = await lockPostFor(tx, actor, postId, "changeSlug");
    await assertExpectedVersion(tx, post, expectedVersion);
    if (post.slug === slug) return { post, publicChange: null };

    await lockSlugs(tx, [post.slug, slug]);
    const { isOwnRedirect } = await assertSlugAvailable(tx, slug, post.id);
    if (isOwnRedirect) {
      await tx.delete(slugRedirects).where(eq(slugRedirects.oldSlug, slug));
    }
    if (post.firstPublishedAt) {
      await tx
        .insert(slugRedirects)
        .values({ oldSlug: post.slug, postId: post.id, createdAt: now });
    }

    const [updated] = await tx
      .update(posts)
      .set({ slug, version: post.version + 1, updatedAt: now })
      .where(eq(posts.id, post.id))
      .returning();
    const publicChange = post.publishedRevisionId
      ? { id: post.id, slugs: [post.slug, slug] }
      : null;
    return { post: updated, publicChange };
  });
}

/** Deletes a post with all of its revisions and redirects. */
export async function deletePost(input: {
  actor: Actor;
  postId: string;
  expectedVersion: number;
}): Promise<{ publicChange: PublicChange | null }> {
  const { actor, postId, expectedVersion } = input;
  return db.transaction(async (tx) => {
    const post = await lockPostFor(tx, actor, postId, "delete");
    await assertExpectedVersion(tx, post, expectedVersion);
    await tx.delete(posts).where(eq(posts.id, post.id));
    return {
      publicChange: post.publishedRevisionId ? { id: post.id, slugs: [post.slug] } : null,
    };
  });
}

/** Deletes several posts with their revisions and redirects. Every post must be deletable. */
export async function deletePosts(input: {
  actor: Actor;
  postIds: string[];
}): Promise<{ deleted: string[]; publicChanges: PublicChange[] }> {
  const { actor, postIds } = input;
  const ids = [...new Set(postIds)];
  const rows = await db.select().from(posts).where(inArray(posts.id, ids));
  if (rows.length !== ids.length) throw notFoundError("Post not found.");
  for (const post of rows) authorizePost(actor, "delete", post);

  await db.delete(posts).where(inArray(posts.id, ids));
  return {
    deleted: ids,
    publicChanges: rows
      .filter((post) => post.publishedRevisionId !== null)
      .map((post) => ({ id: post.id, slugs: [post.slug] })),
  };
}

/** A post the actor may view, or `not_found`. */
export async function getPostForActor(actor: Actor, postId: string): Promise<Post> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || !canOnPost(actor, "view", post)) throw notFoundError("Post not found.");
  return post;
}

export type PostListItem = {
  id: string;
  slug: string;
  status: PostStatus;
  title: string | null;
  authorId: string;
  authorName: string;
  updatedAt: Date;
  publishedAt: Date | null;
  scheduledFor: Date | null;
  firstPublishedAt: Date | null;
};

export async function listPostsForActor(
  actor: Actor,
  filters: { status?: PostStatus; authorId?: string },
): Promise<PostListItem[]> {
  const conditions: SQL[] = [];
  if (actor.role === "author") conditions.push(eq(posts.authorId, actor.id));
  if (filters.status) conditions.push(eq(posts.status, filters.status));
  if (filters.authorId) conditions.push(eq(posts.authorId, filters.authorId));

  return db
    .select({
      id: posts.id,
      slug: posts.slug,
      status: posts.status,
      title: revisions.title,
      authorId: posts.authorId,
      authorName: users.name,
      updatedAt: posts.updatedAt,
      publishedAt: posts.publishedAt,
      scheduledFor: posts.scheduledFor,
      firstPublishedAt: posts.firstPublishedAt,
    })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .leftJoin(revisions, eq(revisions.id, posts.latestRevisionId))
    .where(and(...conditions))
    .orderBy(desc(posts.updatedAt))
    .limit(200);
}

/** Authors who own at least one post, for the admin list filter. */
export async function listPostAuthors(): Promise<Array<{ id: string; name: string }>> {
  return db
    .selectDistinct({ id: users.id, name: users.name })
    .from(users)
    .innerJoin(posts, eq(posts.authorId, users.id))
    .orderBy(asc(users.name));
}
