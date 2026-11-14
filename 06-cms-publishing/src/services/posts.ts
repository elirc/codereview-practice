import { and, asc, desc, eq, type SQL } from "drizzle-orm";
import { canOnPost, type Actor } from "@/auth/policy";
import { db } from "@/db/client";
import { posts, revisions, users, type Post, type PostStatus } from "@/db/schema";
import { notFoundError } from "./errors";
import { assertSlugAvailable, lockSlugs } from "./slugs";

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

/** Creates a draft post together with its first revision. */
export async function createPost(input: {
  actor: Actor;
  slug: string;
  title: string;
  now: Date;
}): Promise<Post> {
  const { actor, slug, title, now } = input;
  return db.transaction(async (tx) => {
    await lockSlugs(tx, [slug]);
    await assertSlugAvailable(tx, slug, null);

    const [post] = await tx
      .insert(posts)
      .values({ slug, authorId: actor.id, status: "draft", createdAt: now, updatedAt: now })
      .returning();
    const [revision] = await tx
      .insert(revisions)
      .values({ postId: post.id, number: 1, title, createdBy: actor.id, createdAt: now })
      .returning();
    const [withRevision] = await tx
      .update(posts)
      .set({ latestRevisionId: revision.id })
      .where(eq(posts.id, post.id))
      .returning();
    return withRevision;
  });
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
