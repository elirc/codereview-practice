import type { Actor } from "@/auth/policy";
import * as workflow from "@/services/workflow";
import { FIXED_NOW, secondsAfter } from "./fixtures";
import { getPost } from "./records";

/** Moves a post into a given workflow state through the services, acting as `editor`. */
export const toState = {
  async inReview(editor: Actor, postId: string) {
    const post = await getPost(postId);
    await workflow.submitForReview(command(editor, postId, post.version));
  },

  async published(editor: Actor, postId: string) {
    const post = await getPost(postId);
    await workflow.publishPost({
      ...command(editor, postId, post.version),
      revisionId: post.latestRevisionId!,
    });
  },

  async scheduled(editor: Actor, postId: string) {
    const post = await getPost(postId);
    await workflow.schedulePost({
      ...command(editor, postId, post.version),
      revisionId: post.latestRevisionId!,
      scheduledFor: secondsAfter(FIXED_NOW, 3600),
    });
  },

  async unpublished(editor: Actor, postId: string) {
    await toState.published(editor, postId);
    const post = await getPost(postId);
    await workflow.unpublishPost(command(editor, postId, post.version));
  },

  async archived(editor: Actor, postId: string) {
    const post = await getPost(postId);
    await workflow.archivePost(command(editor, postId, post.version));
  },
};

function command(actor: Actor, postId: string, expectedVersion: number) {
  return { actor, postId, expectedVersion, now: new Date(FIXED_NOW) };
}
