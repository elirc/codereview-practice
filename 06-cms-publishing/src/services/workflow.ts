import { and, eq, inArray } from "drizzle-orm";
import type { Actor, PostPermission } from "@/auth/policy";
import { db, type Executor } from "@/db/client";
import { media, posts, revisionMedia, revisions, type NewPost, type Post } from "@/db/schema";
import { DomainError } from "./errors";
import { assertExpectedVersion, lockPostFor } from "./post-guards";
import type { PublicChange } from "./posts";
import { nextStatus, type WorkflowAction } from "./workflow-rules";

export const MIN_SCHEDULE_LEAD_MS = 60_000;
export const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

export type WorkflowCommand = {
  actor: Actor;
  postId: string;
  expectedVersion: number;
  now: Date;
};

export type WorkflowOutcome = { post: Post; publicChange: PublicChange | null };

type ChangeBuilder = (tx: Executor, post: Post) => Promise<Partial<NewPost>>;

const PERMISSION_FOR: Record<Exclude<WorkflowAction, "scheduledPublish">, PostPermission> = {
  submit: "submit",
  withdraw: "withdraw",
  publish: "publish",
  schedule: "publish",
  cancelSchedule: "publish",
  unpublish: "publish",
  archive: "publish",
  unarchive: "publish",
};

const CLEARED_SCHEDULE = { scheduledRevisionId: null, scheduledFor: null } as const;
const CLEARED_PUBLICATION = { publishedRevisionId: null, publishedAt: null } as const;

async function transition(
  command: WorkflowCommand,
  action: Exclude<WorkflowAction, "scheduledPublish">,
  buildChanges: ChangeBuilder = async () => ({}),
): Promise<WorkflowOutcome> {
  return db.transaction(async (tx) => {
    const post = await lockPostFor(tx, command.actor, command.postId, PERMISSION_FOR[action]);
    await assertExpectedVersion(tx, post, command.expectedVersion);

    const status = nextStatus(post.status, action, post.publishedRevisionId !== null);
    if (!status) {
      throw new DomainError(
        "invalid_state",
        `A ${post.status.replace("_", " ")} post cannot be changed that way.`,
        { status: post.status, action },
      );
    }

    const changes = await buildChanges(tx, post);
    const [updated] = await tx
      .update(posts)
      .set({ ...changes, status, version: post.version + 1, updatedAt: command.now })
      .where(eq(posts.id, post.id))
      .returning();

    const wentOffline = post.publishedRevisionId !== null && updated.publishedRevisionId === null;
    const publicChange =
      action === "publish" || wentOffline ? { id: updated.id, slugs: [updated.slug] } : null;
    return { post: updated, publicChange };
  });
}

/** Checks the revision belongs to the post and share-locks the media it references. */
async function assertRevisionOfPost(tx: Executor, post: Post, revisionId: string): Promise<void> {
  const [revision] = await tx
    .select({ id: revisions.id })
    .from(revisions)
    .where(and(eq(revisions.id, revisionId), eq(revisions.postId, post.id)));
  if (!revision) {
    throw new DomainError("invalid_revision", "That revision does not belong to this post.");
  }
  await tx
    .select({ id: media.id })
    .from(media)
    .where(
      inArray(
        media.id,
        tx
          .select({ id: revisionMedia.mediaId })
          .from(revisionMedia)
          .where(eq(revisionMedia.revisionId, revisionId)),
      ),
    )
    .for("key share");
}

function publicationFields(post: Post, revisionId: string, now: Date): Partial<NewPost> {
  return {
    publishedRevisionId: revisionId,
    publishedAt: now,
    firstPublishedAt: post.firstPublishedAt ?? now,
    ...CLEARED_SCHEDULE,
  };
}

export function submitForReview(command: WorkflowCommand): Promise<WorkflowOutcome> {
  return transition(command, "submit");
}

export function withdrawFromReview(command: WorkflowCommand): Promise<WorkflowOutcome> {
  return transition(command, "withdraw");
}

export function publishPost(
  command: WorkflowCommand & { revisionId: string },
): Promise<WorkflowOutcome> {
  return transition(command, "publish", async (tx, post) => {
    await assertRevisionOfPost(tx, post, command.revisionId);
    return publicationFields(post, command.revisionId, command.now);
  });
}

export function schedulePost(
  command: WorkflowCommand & { revisionId: string; scheduledFor: Date },
): Promise<WorkflowOutcome> {
  return transition(command, "schedule", async (tx, post) => {
    const at = command.scheduledFor.getTime();
    const now = command.now.getTime();
    if (at < now + MIN_SCHEDULE_LEAD_MS) {
      throw new DomainError("schedule_in_past", "Schedule at least one minute in the future.");
    }
    if (at > now + MAX_SCHEDULE_AHEAD_MS) {
      throw new DomainError("schedule_too_far", "Schedule no more than one year ahead.");
    }
    await assertRevisionOfPost(tx, post, command.revisionId);
    return { scheduledRevisionId: command.revisionId, scheduledFor: command.scheduledFor };
  });
}

export function cancelSchedule(command: WorkflowCommand): Promise<WorkflowOutcome> {
  return transition(command, "cancelSchedule", async () => ({ ...CLEARED_SCHEDULE }));
}

export function unpublishPost(command: WorkflowCommand): Promise<WorkflowOutcome> {
  return transition(command, "unpublish", async () => ({
    ...CLEARED_PUBLICATION,
    ...CLEARED_SCHEDULE,
  }));
}

export function archivePost(command: WorkflowCommand): Promise<WorkflowOutcome> {
  return transition(command, "archive", async () => ({
    ...CLEARED_PUBLICATION,
    ...CLEARED_SCHEDULE,
  }));
}

export function unarchivePost(command: WorkflowCommand): Promise<WorkflowOutcome> {
  return transition(command, "unarchive");
}

/**
 * Publishes the pinned revision of a post the caller has already locked. Used by the
 * scheduler; applies the same field changes as a manual publish.
 */
export async function publishScheduledInTx(tx: Executor, post: Post, now: Date): Promise<Post> {
  const status = nextStatus(post.status, "scheduledPublish", post.publishedRevisionId !== null);
  if (status !== "published" || !post.scheduledRevisionId) {
    throw new DomainError("invalid_state", "The post is no longer scheduled.");
  }
  await assertRevisionOfPost(tx, post, post.scheduledRevisionId);
  const [updated] = await tx
    .update(posts)
    .set({
      ...publicationFields(post, post.scheduledRevisionId, now),
      status,
      version: post.version + 1,
      updatedAt: now,
    })
    .where(eq(posts.id, post.id))
    .returning();
  return updated;
}
