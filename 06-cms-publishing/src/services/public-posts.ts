import { and, count, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { posts, revisions, slugRedirects } from "@/db/schema";
import { renderMarkdown } from "./markdown";

export const PUBLIC_PAGE_SIZE = 10;

// Public read models hold only JSON-safe values (ISO strings, not Dates) because they are
// stored in the data cache.
export type PublishedPost = {
  kind: "post";
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  coverMediaId: string | null;
  html: string;
  publishedAt: string;
  firstPublishedAt: string;
};

export type PublicPostResult = PublishedPost | { kind: "redirect"; slug: string } | null;

export type PublishedPostSummary = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  publishedAt: string;
};

export type PublishedPostPage = {
  items: PublishedPostSummary[];
  page: number;
  totalPages: number;
};

/** The post a slug points at, either as its current slug or as one of its old slugs. */
export async function resolveSlug(slug: string): Promise<string | null> {
  const [current] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.slug, slug))
    .limit(1);
  if (current) return current.id;

  const [redirect] = await db
    .select({ postId: slugRedirects.postId })
    .from(slugRedirects)
    .where(eq(slugRedirects.oldSlug, slug))
    .limit(1);
  return redirect?.postId ?? null;
}

/**
 * The published revision of a post as requested under `slug`. Returns a redirect when `slug`
 * is one of the post's old slugs, and null when the post is not public or the slug is not its own.
 */
export async function loadPublishedPost(postId: string, slug: string): Promise<PublicPostResult> {
  const [row] = await db
    .select({
      id: posts.id,
      slug: posts.slug,
      publishedAt: posts.publishedAt,
      firstPublishedAt: posts.firstPublishedAt,
      title: revisions.title,
      excerpt: revisions.excerpt,
      body: revisions.body,
      coverMediaId: revisions.coverMediaId,
    })
    .from(posts)
    .innerJoin(revisions, eq(revisions.id, posts.publishedRevisionId))
    .where(eq(posts.id, postId))
    .limit(1);
  if (!row || !row.publishedAt) return null;

  if (row.slug !== slug) {
    const [redirect] = await db
      .select({ oldSlug: slugRedirects.oldSlug })
      .from(slugRedirects)
      .where(and(eq(slugRedirects.oldSlug, slug), eq(slugRedirects.postId, postId)))
      .limit(1);
    return redirect ? { kind: "redirect", slug: row.slug } : null;
  }

  return {
    kind: "post",
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    coverMediaId: row.coverMediaId,
    html: renderMarkdown(row.body),
    publishedAt: row.publishedAt.toISOString(),
    firstPublishedAt: (row.firstPublishedAt ?? row.publishedAt).toISOString(),
  };
}

export async function listPublishedPage(page: number): Promise<PublishedPostPage> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(posts)
    .where(isNotNull(posts.publishedRevisionId));

  const rows = await db
    .select({
      id: posts.id,
      slug: posts.slug,
      title: revisions.title,
      excerpt: revisions.excerpt,
      publishedAt: posts.publishedAt,
    })
    .from(posts)
    .innerJoin(revisions, eq(revisions.id, posts.publishedRevisionId))
    .orderBy(desc(posts.publishedAt), desc(posts.id))
    .limit(PUBLIC_PAGE_SIZE)
    .offset((page - 1) * PUBLIC_PAGE_SIZE);

  return {
    page,
    totalPages: Math.max(1, Math.ceil(total / PUBLIC_PAGE_SIZE)),
    items: rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      publishedAt: (row.publishedAt ?? new Date(0)).toISOString(),
    })),
  };
}
