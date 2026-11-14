export const POSTS_LIST_TAG = "posts:list";

export function postTag(postId: string): string {
  return `post:${postId}`;
}

export function postSlugTag(slug: string): string {
  return `post-slug:${slug}`;
}
