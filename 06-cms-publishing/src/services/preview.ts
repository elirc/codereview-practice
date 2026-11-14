import type { Actor } from "@/auth/policy";
import type { Post, Revision } from "@/db/schema";
import { renderMarkdown } from "./markdown";
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
