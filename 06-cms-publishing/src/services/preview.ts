import type { Actor } from "@/auth/policy";
import type { Post, Revision } from "@/db/schema";
import { renderMarkdown } from "./markdown";
import { loadPostContent, resolveSlug, type PublicPostResult } from "./public-posts";
import { getRevisionForActor } from "./revisions";

export type Preview = { post: Post; revision: Revision; html: string };

/** Any revision of a post the actor may view, rendered exactly as the public site would. */
export async function loadPreview(
  actor: Actor,
  postId: string,
  revisionId: string,
): Promise<Preview> {
  const { post, revision } = await getRevisionForActor(actor, postId, revisionId);
  return { post, revision, html: renderMarkdown(revision.body) };
}

/** The latest revision of the post at `slug`, rendered like the public page. Never cached. */
export async function loadLatestBySlug(slug: string): Promise<PublicPostResult> {
  const postId = await resolveSlug(slug);
  if (!postId) return null;
  return loadPostContent(postId, slug, "latest");
}
