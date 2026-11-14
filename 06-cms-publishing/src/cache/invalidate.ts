import { revalidateTag } from "next/cache";
import { POSTS_LIST_TAG, postSlugTag, postTag } from "./tags";

/** Drops every cached public read that can show this post. Call only after the change commits. */
export function invalidatePost({ id, slugs }: { id: string; slugs: string[] }): void {
  revalidateTag(postTag(id));
  for (const slug of new Set(slugs)) revalidateTag(postSlugTag(slug));
  revalidateTag(POSTS_LIST_TAG);
}
