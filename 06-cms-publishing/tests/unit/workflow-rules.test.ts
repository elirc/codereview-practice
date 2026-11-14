import { describe, expect, it } from "vitest";
import type { PostStatus } from "@/db/schema";
import { nextStatus, type WorkflowAction } from "@/services/workflow-rules";

const statuses: PostStatus[] = ["draft", "in_review", "scheduled", "published", "archived"];

type Row = [PostStatus, WorkflowAction, boolean, PostStatus | null];

/** Every legal transition; anything not listed must be rejected. */
const legal: Row[] = [
  ["draft", "submit", false, "in_review"],
  ["in_review", "withdraw", false, "draft"],
  ["draft", "publish", false, "published"],
  ["in_review", "publish", false, "published"],
  ["published", "publish", true, "published"],
  ["draft", "schedule", false, "scheduled"],
  ["in_review", "schedule", false, "scheduled"],
  ["published", "schedule", true, "scheduled"],
  ["scheduled", "schedule", false, "scheduled"],
  ["scheduled", "schedule", true, "scheduled"],
  ["scheduled", "cancelSchedule", true, "published"],
  ["scheduled", "cancelSchedule", false, "draft"],
  ["scheduled", "scheduledPublish", false, "published"],
  ["scheduled", "scheduledPublish", true, "published"],
  ["published", "unpublish", true, "draft"],
  ["draft", "archive", false, "archived"],
  ["in_review", "archive", false, "archived"],
  ["scheduled", "archive", true, "archived"],
  ["scheduled", "archive", false, "archived"],
  ["published", "archive", true, "archived"],
  ["archived", "unarchive", false, "draft"],
];

const actions: WorkflowAction[] = [
  "submit",
  "withdraw",
  "publish",
  "schedule",
  "cancelSchedule",
  "scheduledPublish",
  "unpublish",
  "archive",
  "unarchive",
];

function expectedFor(status: PostStatus, action: WorkflowAction, published: boolean) {
  const row = legal.find(([s, a, p]) => s === status && a === action && p === published);
  if (row) return row[3];
  const anyPublishedState = legal.find(([s, a]) => s === status && a === action);
  // Rows only pin the published flag where it matters; otherwise the result does not depend on it.
  if (anyPublishedState && action !== "cancelSchedule") return anyPublishedState[3];
  return null;
}

describe("workflow transitions", () => {
  it.each(legal)("%s --%s (published=%s)--> %s", (status, action, published, to) => {
    expect(nextStatus(status, action, published)).toBe(to);
  });

  const all = statuses.flatMap((status) =>
    actions.flatMap((action) => [false, true].map((published) => ({ status, action, published }))),
  );

  it.each(all)("$status + $action (published=$published)", ({ status, action, published }) => {
    expect(nextStatus(status, action, published)).toBe(expectedFor(status, action, published));
  });

  it("rejects a manual publish of a scheduled post", () => {
    expect(nextStatus("scheduled", "publish", true)).toBeNull();
    expect(nextStatus("scheduled", "publish", false)).toBeNull();
  });

  it("never transitions out of archived except by unarchive", () => {
    for (const action of actions.filter((a) => a !== "unarchive")) {
      expect(nextStatus("archived", action, false)).toBeNull();
    }
  });
});
