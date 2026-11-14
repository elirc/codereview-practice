import { describe, expect, it } from "vitest";
import { deleteMedia } from "@/actions/media";
import { deletePost, restoreRevision, saveRevision } from "@/actions/posts";
import type { ActionResult } from "@/actions/result";
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
import * as files from "../fixtures/files";
import { clearRevalidations, revalidatedPaths, revalidatedTags } from "./support/fake-next-cache";
import {
  FIXED_NOW,
  createTestUser,
  expectOk,
  secondsAfter,
  signInAs,
} from "./support/fixtures";
import { storeFile } from "./support/media";
import { addRevision, getPost, makePost } from "./support/records";
import { toState } from "./support/states";

const SLUG = "tagged-post";

async function scene(state?: keyof typeof toState) {
  const author = await createTestUser("author");
  const editor = await createTestUser("editor");
  const admin = await createTestUser("admin");
  const post = await makePost(author, SLUG);
  await addRevision(author, post.id, { body: "second revision" });
  if (state) await toState[state](editor, post.id);
  await signInAs(editor);
  clearRevalidations();
  return { author, editor, admin, postId: post.id };
}

async function current(postId: string) {
  const post = await getPost(postId);
  return {
    postId,
    expectedVersion: post.version,
    latestRevisionId: post.latestRevisionId!,
    publishedRevisionId: post.publishedRevisionId,
  };
}

function publicTags(postId: string): string[] {
  return [`post:${postId}`, `post-slug:${SLUG}`, "posts:list"].sort();
}

function recordedTags(): string[] {
  return [...revalidatedTags].sort();
}

async function expectInvalidated(result: Promise<ActionResult<unknown>>, postId: string) {
  expectOk(await result);
  expect(recordedTags()).toEqual(publicTags(postId));
  expect(revalidatedPaths).toEqual([]);
}

async function expectNoInvalidation(result: Promise<ActionResult<unknown>>) {
  expectOk(await result);
  expect(revalidatedTags).toEqual([]);
}

describe("invalidation after public changes", () => {
  it("publish invalidates the post, its slug and the list", async () => {
    const { postId } = await scene();
    const { expectedVersion, latestRevisionId } = await current(postId);
    await expectInvalidated(
      publishPost({ postId, expectedVersion, revisionId: latestRevisionId }),
      postId,
    );
  });

  it("publishing again invalidates again", async () => {
    const { postId } = await scene("published");
    const { expectedVersion, latestRevisionId } = await current(postId);
    await expectInvalidated(
      publishPost({ postId, expectedVersion, revisionId: latestRevisionId }),
      postId,
    );
  });

  it("unpublish invalidates", async () => {
    const { postId } = await scene("published");
    const { expectedVersion } = await current(postId);
    await expectInvalidated(unpublishPost({ postId, expectedVersion }), postId);
  });

  it("archiving a published post invalidates", async () => {
    const { postId } = await scene("published");
    const { expectedVersion } = await current(postId);
    await expectInvalidated(archivePost({ postId, expectedVersion }), postId);
  });

  it("archiving a scheduled post that is still live invalidates", async () => {
    const { editor, postId } = await scene("published");
    await toState.scheduled(editor, postId);
    clearRevalidations();
    const { expectedVersion } = await current(postId);
    await expectInvalidated(archivePost({ postId, expectedVersion }), postId);
  });

  it("deleting a published post invalidates", async () => {
    const { admin, postId } = await scene("published");
    await signInAs(admin);
    const { expectedVersion } = await current(postId);
    await expectInvalidated(deletePost({ postId, expectedVersion }), postId);
  });
});

describe("no invalidation when public content is unchanged", () => {
  it("saving and restoring revisions on a published post", async () => {
    const { author, postId } = await scene("published");
    await signInAs(author);
    let state = await current(postId);
    await expectNoInvalidation(
      saveRevision({
        postId,
        expectedVersion: state.expectedVersion,
        title: "Draft change",
        body: "not public",
      }),
    );
    state = await current(postId);
    await expectNoInvalidation(
      restoreRevision({
        postId,
        expectedVersion: state.expectedVersion,
        revisionId: state.publishedRevisionId!,
      }),
    );
  });

  it("submit and withdraw", async () => {
    const { postId } = await scene();
    let { expectedVersion } = await current(postId);
    await expectNoInvalidation(submitForReview({ postId, expectedVersion }));
    ({ expectedVersion } = await current(postId));
    await expectNoInvalidation(withdrawFromReview({ postId, expectedVersion }));
  });

  it("schedule and cancel schedule, including on a live post", async () => {
    const { postId } = await scene("published");
    let state = await current(postId);
    await expectNoInvalidation(
      schedulePost({
        postId,
        expectedVersion: state.expectedVersion,
        revisionId: state.latestRevisionId,
        scheduledFor: secondsAfter(FIXED_NOW, 3600).toISOString(),
      }),
    );
    state = await current(postId);
    await expectNoInvalidation(cancelSchedule({ postId, expectedVersion: state.expectedVersion }));
  });

  it("archiving and unarchiving a draft", async () => {
    const { postId } = await scene();
    let { expectedVersion } = await current(postId);
    await expectNoInvalidation(archivePost({ postId, expectedVersion }));
    ({ expectedVersion } = await current(postId));
    await expectNoInvalidation(unarchivePost({ postId, expectedVersion }));
  });

  it("deleting a never-published post", async () => {
    const { author, postId } = await scene();
    await signInAs(author);
    const { expectedVersion } = await current(postId);
    await expectNoInvalidation(deletePost({ postId, expectedVersion }));
  });

  it("deleting media", async () => {
    const { author } = await scene();
    const stored = await storeFile(author.id, files.png());
    await signInAs(author);
    await expectNoInvalidation(deleteMedia({ mediaId: stored.id }));
  });

  it("refused actions", async () => {
    const { author, postId } = await scene("published");
    await signInAs(author);
    const { expectedVersion } = await current(postId);
    const result = await unpublishPost({ postId, expectedVersion });
    expect(result.ok).toBe(false);
    expect(revalidatedTags).toEqual([]);
  });
});
