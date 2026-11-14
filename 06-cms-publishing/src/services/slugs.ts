import { and, eq, ne, sql } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { posts, slugRedirects } from "@/db/schema";
import { DomainError } from "./errors";

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Takes transaction-scoped advisory locks on the given slugs, in a stable order. */
export async function lockSlugs(tx: Executor, slugs: string[]): Promise<void> {
  for (const slug of [...new Set(slugs)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`post-slug:${slug}`}))`);
  }
}

/**
 * Ensures `slug` is free for `postId` (or for a new post when null). Returns whether the slug
 * is currently one of this post's own redirects.
 */
export async function assertSlugAvailable(
  tx: Executor,
  slug: string,
  postId: string | null,
): Promise<{ isOwnRedirect: boolean }> {
  const [current] = await tx
    .select({ id: posts.id })
    .from(posts)
    .where(postId ? and(eq(posts.slug, slug), ne(posts.id, postId)) : eq(posts.slug, slug))
    .limit(1);
  if (current) throw slugTaken(slug);

  const [redirect] = await tx
    .select({ postId: slugRedirects.postId })
    .from(slugRedirects)
    .where(eq(slugRedirects.oldSlug, slug))
    .limit(1);
  if (redirect && redirect.postId !== postId) throw slugTaken(slug);

  return { isOwnRedirect: redirect !== undefined };
}

function slugTaken(slug: string): DomainError {
  return new DomainError("slug_taken", "That slug is already in use.", { slug });
}
