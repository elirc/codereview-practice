import { describe, expect, it } from "vitest";
import { changeSlug } from "@/actions/posts";
import { publishPost } from "@/actions/workflow";
import { clearRevalidations, revalidatedTags } from "./support/fake-next-cache";
import { createTestUser, errorCode, expectOk, signInAs } from "./support/fixtures";
import { getPost, getRedirects, makePost } from "./support/records";

async function publish(postId: string) {
  const post = await getPost(postId);
  return expectOk(
    await publishPost({
      postId,
      revisionId: post.latestRevisionId!,
      expectedVersion: post.version,
    }),
  );
}

describe("changeSlug", () => {
  it("renames a never-published post without a redirect or invalidation", async () => {
    const author = await createTestUser("author");
    const post = await makePost(author, "first-name");
    await signInAs(author);

    const renamed = expectOk(
      await changeSlug({ postId: post.id, expectedVersion: 1, slug: "second-name" }),
    );

    expect(renamed.slug).toBe("second-name");
    expect(await getRedirects(post.id)).toEqual([]);
    expect(revalidatedTags).toEqual([]);
  });

  it("redirects the old slug of a published post and invalidates both slugs", async () => {
    const author = await createTestUser("author");
    const editor = await createTestUser("editor");
    const post = await makePost(author, "launch-notes");
    await signInAs(editor);
    const live = await publish(post.id);
    clearRevalidations();

    const renamed = expectOk(
      await changeSlug({ postId: post.id, expectedVersion: live.version, slug: "release-notes" }),
    );

    expect((await getRedirects(post.id)).map((r) => r.oldSlug)).toEqual(["launch-notes"]);
    const expectedTags = [
      `post:${post.id}`,
      "post-slug:launch-notes",
      "post-slug:release-notes",
      "posts:list",
    ];
    expect([...revalidatedTags].sort()).toEqual(expectedTags.sort());

    const back = expectOk(
      await changeSlug({ postId: post.id, expectedVersion: renamed.version, slug: "launch-notes" }),
    );
    expect(back.slug).toBe("launch-notes");
    expect((await getRedirects(post.id)).map((r) => r.oldSlug)).toEqual(["release-notes"]);
  });

  it("refuses a slug owned by another post or by another post's redirect", async () => {
    const author = await createTestUser("author");
    const editor = await createTestUser("editor");
    const mine = await makePost(author, "mine");
    const theirs = await makePost(author, "theirs");
    await signInAs(editor);
    const live = await publish(theirs.id);
    expectOk(await changeSlug({ postId: theirs.id, expectedVersion: live.version, slug: "moved" }));

    expect(
      errorCode(await changeSlug({ postId: mine.id, expectedVersion: 1, slug: "moved" })),
    ).toBe("slug_taken");
    expect(
      errorCode(await changeSlug({ postId: mine.id, expectedVersion: 1, slug: "theirs" })),
    ).toBe("slug_taken");
    expect((await getPost(mine.id)).slug).toBe("mine");
  });

  it("lets only one of two posts claim the same slug at once", async () => {
    const author = await createTestUser("author");
    const first = await makePost(author, "alpha");
    const second = await makePost(author, "beta");
    await signInAs(author);

    const results = await Promise.all([
      changeSlug({ postId: first.id, expectedVersion: 1, slug: "gamma" }),
      changeSlug({ postId: second.id, expectedVersion: 1, slug: "gamma" }),
    ]);

    expect(results.map(errorCode).sort()).toEqual([null, "slug_taken"].sort());
  });

  it("allows an author to rename only while the post was never published", async () => {
    const author = await createTestUser("author");
    const editor = await createTestUser("editor");
    const post = await makePost(author, "draft-name");
    await signInAs(author);
    const renamed = expectOk(
      await changeSlug({ postId: post.id, expectedVersion: 1, slug: "better-name" }),
    );

    await signInAs(editor);
    const live = await publish(post.id);
    expect(live.version).toBe(renamed.version + 1);

    await signInAs(author);
    expect(
      errorCode(
        await changeSlug({ postId: post.id, expectedVersion: live.version, slug: "third-name" }),
      ),
    ).toBe("forbidden");
  });
});
