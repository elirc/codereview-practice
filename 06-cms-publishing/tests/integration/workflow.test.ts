import { describe, expect, it } from "vitest";
import { deleteMedia } from "@/actions/media";
import { changeSlug, deletePost, saveRevision } from "@/actions/posts";
import {
  archivePost,
  cancelSchedule,
  publishPost,
  schedulePost,
  submitForReview,
  unarchivePost,
  unpublishPost,
  withdrawFromReview,
} from "@/actions/workflow";
import {
  FIXED_NOW,
  createTestUser,
  errorCode,
  expectOk,
  secondsAfter,
  setNow,
  signInAs,
} from "./support/fixtures";
import * as files from "../fixtures/files";
import { storeFile } from "./support/media";
import { addRevision, getPost, makePost, snapshotPost } from "./support/records";

async function setup() {
  const author = await createTestUser("author");
  const editor = await createTestUser("editor");
  const post = await makePost(author, "workflow-post");
  return { author, editor, post };
}

async function publishLatest(postId: string) {
  const post = await getPost(postId);
  return publishPost({
    postId,
    revisionId: post.latestRevisionId!,
    expectedVersion: post.version,
  });
}

async function scheduleLatest(postId: string, at: Date) {
  const post = await getPost(postId);
  return schedulePost({
    postId,
    revisionId: post.latestRevisionId!,
    expectedVersion: post.version,
    scheduledFor: at.toISOString(),
  });
}

describe("review", () => {
  it("lets the author submit and withdraw their own post", async () => {
    const { author, post } = await setup();
    await signInAs(author);

    const submitted = expectOk(await submitForReview({ postId: post.id, expectedVersion: 1 }));
    expect(submitted).toMatchObject({ status: "in_review", version: 2 });

    const withdrawn = expectOk(await withdrawFromReview({ postId: post.id, expectedVersion: 2 }));
    expect(withdrawn).toMatchObject({ status: "draft", version: 3 });
  });

  it("rejects transitions that are not legal from the current status", async () => {
    const { author, post } = await setup();
    await signInAs(author);
    expect(errorCode(await withdrawFromReview({ postId: post.id, expectedVersion: 1 }))).toBe(
      "invalid_state",
    );
  });

  it("checks the expected version", async () => {
    const { author, post } = await setup();
    await signInAs(author);
    expect(errorCode(await submitForReview({ postId: post.id, expectedVersion: 7 }))).toBe(
      "version_conflict",
    );
    expect((await getPost(post.id)).status).toBe("draft");
  });
});

describe("publish", () => {
  it("publishes the given revision and stamps the publication times", async () => {
    const { editor, post } = await setup();
    await signInAs(editor);

    const published = expectOk(await publishLatest(post.id));

    expect(published).toMatchObject({
      status: "published",
      publishedRevisionId: post.latestRevisionId,
      scheduledRevisionId: null,
      scheduledFor: null,
    });
    expect(published.publishedAt?.toISOString()).toBe(FIXED_NOW);
    expect(published.firstPublishedAt?.toISOString()).toBe(FIXED_NOW);
  });

  it("keeps the first publication time when publishing again", async () => {
    const { author, editor, post } = await setup();
    await signInAs(editor);
    expectOk(await publishLatest(post.id));
    await addRevision(author, post.id, { body: "second take" });
    const later = setNow("2030-02-01T08:00:00.000Z");

    const republished = expectOk(await publishLatest(post.id));

    expect(republished.publishedAt?.toISOString()).toBe(later.toISOString());
    expect(republished.firstPublishedAt?.toISOString()).toBe(FIXED_NOW);
  });

  it("rejects a revision that belongs to another post", async () => {
    const { author, editor, post } = await setup();
    const other = await makePost(author, "other-post");
    await signInAs(editor);
    const before = await snapshotPost(post.id);

    const result = await publishPost({
      postId: post.id,
      revisionId: other.latestRevisionId!,
      expectedVersion: 1,
    });

    expect(errorCode(result)).toBe("invalid_revision");
    expect(await snapshotPost(post.id)).toEqual(before);
  });

  it("forbids an author from publishing their own post", async () => {
    const { author, post } = await setup();
    await signInAs(author);
    const before = await snapshotPost(post.id);

    expect(errorCode(await publishLatest(post.id))).toBe("forbidden");
    expect(await snapshotPost(post.id)).toEqual(before);
  });

  it("does not let a scheduled post be published manually", async () => {
    const { editor, post } = await setup();
    await signInAs(editor);
    expectOk(await scheduleLatest(post.id, secondsAfter(FIXED_NOW, 3600)));

    expect(errorCode(await publishLatest(post.id))).toBe("invalid_state");
    expect((await getPost(post.id)).status).toBe("scheduled");
  });
});

describe("schedule", () => {
  it("requires at least one minute of lead time", async () => {
    const { editor, post } = await setup();
    await signInAs(editor);

    expect(errorCode(await scheduleLatest(post.id, secondsAfter(FIXED_NOW, 59)))).toBe(
      "schedule_in_past",
    );
    expect((await getPost(post.id)).status).toBe("draft");

    const scheduled = expectOk(await scheduleLatest(post.id, secondsAfter(FIXED_NOW, 60)));
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.scheduledFor?.toISOString()).toBe("2030-01-15T10:01:00.000Z");
  });

  it("refuses dates more than a year ahead", async () => {
    const { editor, post } = await setup();
    await signInAs(editor);
    const tooFar = secondsAfter(FIXED_NOW, 365 * 24 * 3600 + 1);
    expect(errorCode(await scheduleLatest(post.id, tooFar))).toBe("schedule_too_far");
  });

  it("pins the scheduled revision even when the author keeps saving", async () => {
    const { author, editor, post } = await setup();
    await signInAs(editor);
    const scheduled = expectOk(await scheduleLatest(post.id, secondsAfter(FIXED_NOW, 3600)));

    await signInAs(author);
    const saved = expectOk(
      await saveRevision({
        postId: post.id,
        expectedVersion: scheduled.version,
        title: "Later",
        body: "newer words",
      }),
    );

    expect(saved.post.status).toBe("scheduled");
    expect(saved.post.scheduledRevisionId).toBe(post.latestRevisionId);
    expect(saved.post.latestRevisionId).not.toBe(post.latestRevisionId);
  });

  it("replaces both schedule fields when rescheduling", async () => {
    const { author, editor, post } = await setup();
    await signInAs(editor);
    expectOk(await scheduleLatest(post.id, secondsAfter(FIXED_NOW, 3600)));
    const newer = await addRevision(author, post.id, { body: "revised" });

    const rescheduled = expectOk(await scheduleLatest(post.id, secondsAfter(FIXED_NOW, 7200)));

    expect(rescheduled.scheduledRevisionId).toBe(newer.revision.id);
    expect(rescheduled.scheduledFor?.toISOString()).toBe("2030-01-15T12:00:00.000Z");
  });

  it("keeps a published post live with its old revision while scheduled", async () => {
    const { author, editor, post } = await setup();
    await signInAs(editor);
    const live = expectOk(await publishLatest(post.id));
    await addRevision(author, post.id, { body: "next version" });

    const scheduled = expectOk(await scheduleLatest(post.id, secondsAfter(FIXED_NOW, 3600)));

    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.publishedRevisionId).toBe(live.publishedRevisionId);
    expect(scheduled.publishedAt?.toISOString()).toBe(FIXED_NOW);
  });
});

describe("cancel schedule", () => {
  it("returns a previously published post to published with the old revision", async () => {
    const { author, editor, post } = await setup();
    await signInAs(editor);
    const live = expectOk(await publishLatest(post.id));
    await addRevision(author, post.id, { body: "draft for later" });
    const scheduled = expectOk(await scheduleLatest(post.id, secondsAfter(FIXED_NOW, 3600)));

    const cancelled = expectOk(
      await cancelSchedule({ postId: post.id, expectedVersion: scheduled.version }),
    );

    expect(cancelled).toMatchObject({
      status: "published",
      publishedRevisionId: live.publishedRevisionId,
      scheduledRevisionId: null,
      scheduledFor: null,
    });
  });

  it("returns a never-published post to draft", async () => {
    const { editor, post } = await setup();
    await signInAs(editor);
    const scheduled = expectOk(await scheduleLatest(post.id, secondsAfter(FIXED_NOW, 3600)));

    const cancelled = expectOk(
      await cancelSchedule({ postId: post.id, expectedVersion: scheduled.version }),
    );

    expect(cancelled).toMatchObject({ status: "draft", publishedRevisionId: null });
  });
});

describe("unpublish and archive", () => {
  it("unpublish clears the publication but keeps the first publication time", async () => {
    const { author, editor, post } = await setup();
    await signInAs(editor);
    const live = expectOk(await publishLatest(post.id));

    const unpublished = expectOk(
      await unpublishPost({ postId: post.id, expectedVersion: live.version }),
    );

    expect(unpublished).toMatchObject({
      status: "draft",
      publishedRevisionId: null,
      publishedAt: null,
    });
    expect(unpublished.firstPublishedAt?.toISOString()).toBe(FIXED_NOW);

    await signInAs(author);
    const slugAttempt = await changeSlug({
      postId: post.id,
      expectedVersion: unpublished.version,
      slug: "renamed",
    });
    const deleteAttempt = await deletePost({
      postId: post.id,
      expectedVersion: unpublished.version,
    });
    expect(errorCode(slugAttempt)).toBe("forbidden");
    expect(errorCode(deleteAttempt)).toBe("forbidden");
  });

  it("archive clears publication and schedule; unarchive returns to draft", async () => {
    const { editor, post } = await setup();
    await signInAs(editor);
    const live = expectOk(await publishLatest(post.id));
    const scheduled = expectOk(await scheduleLatest(post.id, secondsAfter(FIXED_NOW, 600)));
    expect(scheduled.version).toBe(live.version + 1);

    const archived = expectOk(
      await archivePost({ postId: post.id, expectedVersion: scheduled.version }),
    );
    expect(archived).toMatchObject({
      status: "archived",
      publishedRevisionId: null,
      publishedAt: null,
      scheduledRevisionId: null,
      scheduledFor: null,
    });
    const again = await archivePost({ postId: post.id, expectedVersion: archived.version });
    expect(errorCode(again)).toBe("invalid_state");

    const restored = expectOk(
      await unarchivePost({ postId: post.id, expectedVersion: archived.version }),
    );
    expect(restored.status).toBe("draft");
  });
});

describe("deletePost", () => {
  it("lets an author delete their never-published post with its revisions", async () => {
    const { author, post } = await setup();
    await addRevision(author, post.id, { body: "more" });
    await signInAs(author);

    expectOk(await deletePost({ postId: post.id, expectedVersion: 2 }));

    expect(await getPost(post.id)).toBeUndefined();
  });

  it("lets an admin delete a published post", async () => {
    const { editor, post } = await setup();
    const admin = await createTestUser("admin");
    await signInAs(editor);
    const live = expectOk(await publishLatest(post.id));

    await signInAs(admin);
    expectOk(await deletePost({ postId: post.id, expectedVersion: live.version }));
    expect(await getPost(post.id)).toBeUndefined();
  });

  it("does not let an editor delete", async () => {
    const { editor, post } = await setup();
    await signInAs(editor);
    expect(errorCode(await deletePost({ postId: post.id, expectedVersion: 1 }))).toBe("forbidden");
    expect(await getPost(post.id)).toBeDefined();
  });
});

describe("revisions that refer to deleted media", () => {
  async function revisionWithDeletedMedia() {
    const { author, editor, post } = await setup();
    const admin = await createTestUser("admin");
    const stored = await storeFile(author.id, files.png());
    await addRevision(author, post.id, { body: `![pic](media:${stored.id})` });
    await signInAs(admin);
    expectOk(await deleteMedia({ mediaId: stored.id }));
    await signInAs(editor);
    return { post, mediaId: stored.id };
  }

  it("refuses to publish the revision", async () => {
    const { post, mediaId } = await revisionWithDeletedMedia();
    const before = await snapshotPost(post.id);

    const result = await publishLatest(post.id);

    expect(errorCode(result)).toBe("invalid_media_reference");
    expect(result.ok ? null : result.error.details).toEqual({ missing: [mediaId] });
    expect(await snapshotPost(post.id)).toEqual(before);
  });

  it("refuses to schedule the revision", async () => {
    const { post } = await revisionWithDeletedMedia();
    const before = await snapshotPost(post.id);

    const result = await scheduleLatest(post.id, secondsAfter(FIXED_NOW, 3600));

    expect(errorCode(result)).toBe("invalid_media_reference");
    expect(await snapshotPost(post.id)).toEqual(before);
  });
});
