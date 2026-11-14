import { revalidateTag } from "next/cache";
import { POSTS_LIST_TAG, postSlugTag, postTag } from "./tags";

/** Revalidates the post's tag, the given slug tags and the post list tag. */
export function invalidatePost({ id, slugs }: { id: string; slugs: string[] }): void {
  revalidateTag(postTag(id));
  for (const slug of new Set(slugs)) revalidateTag(postSlugTag(slug));
  revalidateTag(POSTS_LIST_TAG);
}
