import { desc, eq } from "drizzle-orm";
import { authorizePost, type Actor, type PostPermission } from "@/auth/policy";
import type { Executor } from "@/db/client";
import { posts, revisions, users, type Post } from "@/db/schema";
import { DomainError, notFoundError } from "./errors";

/** Loads a post with `FOR UPDATE`, so the caller's transaction owns the row until commit. */
export async function lockPost(tx: Executor, postId: string): Promise<Post | null> {
  const [post] = await tx.select().from(posts).where(eq(posts.id, postId)).for("update");
  return post ?? null;
}

/** Locks the post and checks the actor's permission against the locked state. */
export async function lockPostFor(
  tx: Executor,
  actor: Actor,
  postId: string,
  permission: PostPermission,
): Promise<Post> {
  const post = await lockPost(tx, postId);
  if (!post) throw notFoundError("Post not found.");
  authorizePost(actor, permission, post);
  return post;
}

export async function assertExpectedVersion(
  tx: Executor,
  post: Post,
  expectedVersion: number,
): Promise<void> {
  if (post.version === expectedVersion) return;

  const [latest] = await tx
    .select({ number: revisions.number, userId: users.id, userName: users.name })
    .from(revisions)
    .innerJoin(users, eq(users.id, revisions.createdBy))
    .where(eq(revisions.postId, post.id))
    .orderBy(desc(revisions.number))
    .limit(1);

  throw new DomainError(
    "version_conflict",
    "This post was changed by someone else. Reload to see the latest version.",
    {
      currentVersion: post.version,
      latestRevisionNumber: latest?.number ?? null,
      savedBy: latest ? { id: latest.userId, name: latest.userName } : null,
    },
  );
}
