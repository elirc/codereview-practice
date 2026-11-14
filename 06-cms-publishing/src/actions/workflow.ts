"use server";

import { requireUser } from "@/auth/current-user";
import { invalidatePost } from "@/cache/invalidate";
import { clock } from "@/services/clock";
import { toPostState, type PostState } from "@/services/posts";
import * as workflow from "@/services/workflow";
import { runAction, type ActionResult } from "./result";
import { postCommandSchema, publishSchema, scheduleSchema } from "./schemas";

function settle(outcome: workflow.WorkflowOutcome): PostState {
  if (outcome.publicChange) invalidatePost(outcome.publicChange);
  return toPostState(outcome.post);
}

export async function submitForReview(input: unknown): Promise<ActionResult<PostState>> {
  return runAction("submitForReview", async () => {
    const data = postCommandSchema.parse(input);
    const actor = await requireUser();
    return settle(await workflow.submitForReview({ actor, ...data, now: clock.now() }));
  });
}

export async function withdrawFromReview(input: unknown): Promise<ActionResult<PostState>> {
  return runAction("withdrawFromReview", async () => {
    const data = postCommandSchema.parse(input);
    const actor = await requireUser();
    return settle(await workflow.withdrawFromReview({ actor, ...data, now: clock.now() }));
  });
}

export async function publishPost(input: unknown): Promise<ActionResult<PostState>> {
  return runAction("publishPost", async () => {
    const data = publishSchema.parse(input);
    const actor = await requireUser();
    return settle(await workflow.publishPost({ actor, ...data, now: clock.now() }));
  });
}

export async function schedulePost(input: unknown): Promise<ActionResult<PostState>> {
  return runAction("schedulePost", async () => {
    const data = scheduleSchema.parse(input);
    const actor = await requireUser();
    return settle(await workflow.schedulePost({ actor, ...data, now: clock.now() }));
  });
}

export async function cancelSchedule(input: unknown): Promise<ActionResult<PostState>> {
  return runAction("cancelSchedule", async () => {
    const data = postCommandSchema.parse(input);
    const actor = await requireUser();
    return settle(await workflow.cancelSchedule({ actor, ...data, now: clock.now() }));
  });
}

export async function unpublishPost(input: unknown): Promise<ActionResult<PostState>> {
  return runAction("unpublishPost", async () => {
    const data = postCommandSchema.parse(input);
    const actor = await requireUser();
    return settle(await workflow.unpublishPost({ actor, ...data, now: clock.now() }));
  });
}

export async function archivePost(input: unknown): Promise<ActionResult<PostState>> {
  return runAction("archivePost", async () => {
    const data = postCommandSchema.parse(input);
    const actor = await requireUser();
    return settle(await workflow.archivePost({ actor, ...data, now: clock.now() }));
  });
}

export async function unarchivePost(input: unknown): Promise<ActionResult<PostState>> {
  return runAction("unarchivePost", async () => {
    const data = postCommandSchema.parse(input);
    const actor = await requireUser();
    return settle(await workflow.unarchivePost({ actor, ...data, now: clock.now() }));
  });
}
