import { unstable_cache } from "next/cache";
import {
  listPublishedPage,
  loadPostContent,
  resolveSlug,
  type PublicPostResult,
  type PublishedPostPage,
} from "@/services/public-posts";
import { POSTS_LIST_TAG, postSlugTag, postTag } from "./tags";

/** Published content for a public slug: the post, a redirect to its current slug, or null. */
export async function getPublishedPostBySlug(slug: string): Promise<PublicPostResult> {
  const postId = await unstable_cache(() => resolveSlug(slug), ["public-slug", slug], {
    tags: [postSlugTag(slug)],
  })();
  if (!postId) return null;

  return unstable_cache(() => loadPostContent(postId, slug), ["public-post", postId, slug], {
    tags: [postTag(postId), postSlugTag(slug)],
  })();
}

export async function listPublishedPosts(page: number): Promise<PublishedPostPage> {
  return unstable_cache(() => listPublishedPage(page), ["public-list", String(page)], {
    tags: [POSTS_LIST_TAG],
  })();
}
