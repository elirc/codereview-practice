import type { PostStatus } from "@/db/schema";

export type WorkflowAction =
  | "submit"
  | "withdraw"
  | "publish"
  | "schedule"
  | "cancelSchedule"
  | "unpublish"
  | "archive"
  | "unarchive"
  | "scheduledPublish";

const PUBLISHABLE_FROM: readonly PostStatus[] = ["draft", "in_review", "published"];

/**
 * The status a post moves to when `action` is applied, or null when the transition is not
 * allowed from `current`.
 */
export function nextStatus(
  current: PostStatus,
  action: WorkflowAction,
  hasPublishedRevision: boolean,
): PostStatus | null {
  switch (action) {
    case "submit":
      return current === "draft" ? "in_review" : null;
    case "withdraw":
      return current === "in_review" ? "draft" : null;
    case "publish":
      return PUBLISHABLE_FROM.includes(current) ? "published" : null;
    case "schedule":
      return PUBLISHABLE_FROM.includes(current) || current === "scheduled" ? "scheduled" : null;
    case "cancelSchedule":
      if (current !== "scheduled") return null;
      return hasPublishedRevision ? "published" : "draft";
    case "scheduledPublish":
      return current === "scheduled" ? "published" : null;
    case "unpublish":
      return current === "published" ? "draft" : null;
    case "archive":
      return current === "archived" ? null : "archived";
    case "unarchive":
      return current === "archived" ? "draft" : null;
  }
}
