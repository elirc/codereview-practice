"use server";

import { requireUser } from "@/auth/current-user";
import { assertCan } from "@/auth/policy";
import { clock } from "@/services/clock";
import * as postService from "@/services/posts";
import { toPostState, type PostState } from "@/services/posts";
import * as revisionService from "@/services/revisions";
import { runAction, type ActionResult } from "./result";
import { createPostSchema, restoreRevisionSchema, saveRevisionSchema } from "./schemas";

export type SavedRevision = {
  post: PostState;
  revisionId: string;
  revisionNumber: number;
  created: boolean;
};

export async function createPost(input: unknown): Promise<ActionResult<PostState>> {
  return runAction("createPost", async () => {
    const data = createPostSchema.parse(input);
    const actor = await requireUser();
    assertCan(actor, "createPost");
    const post = await postService.createPost({ actor, ...data, now: clock.now() });
    return toPostState(post);
  });
}

export async function saveRevision(input: unknown): Promise<ActionResult<SavedRevision>> {
  return runAction("saveRevision", async () => {
    const { postId, expectedVersion, ...content } = saveRevisionSchema.parse(input);
    const actor = await requireUser();
    const outcome = await revisionService.saveRevision({
      actor,
      postId,
      expectedVersion,
      content,
      now: clock.now(),
    });
    return {
      post: toPostState(outcome.post),
      revisionId: outcome.revision.id,
      revisionNumber: outcome.revision.number,
      created: outcome.created,
    };
  });
}

export async function restoreRevision(input: unknown): Promise<ActionResult<SavedRevision>> {
  return runAction("restoreRevision", async () => {
    const data = restoreRevisionSchema.parse(input);
    const actor = await requireUser();
    const outcome = await revisionService.restoreRevision({ actor, ...data, now: clock.now() });
    return {
      post: toPostState(outcome.post),
      revisionId: outcome.revision.id,
      revisionNumber: outcome.revision.number,
      created: outcome.created,
    };
  });
}
