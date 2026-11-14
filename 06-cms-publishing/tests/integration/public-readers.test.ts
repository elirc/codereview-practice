import { describe, expect, it } from "vitest";
import { changeSlug, saveRevision } from "@/actions/posts";
import { archivePost, publishPost, unpublishPost } from "@/actions/workflow";
import { getPublishedPostBySlug, listPublishedPosts } from "@/cache/readers";
import { createTestUser, expectOk, setNow, signInAs } from "./support/fixtures";
import { addRevision, getPost, makePost } from "./support/records";

async function publishLatest(postId: string) {
  const post = await getPost(postId);
  return expectOk(
    await publishPost({
      postId,
      revisionId: post.latestRevisionId!,
      expectedVersion: post.version,
    }),
  );
}

async function setupPublished(slug = "hello") {
  const author = await createTestUser("author");
  const editor = await createTestUser("editor");
  const post = await makePost(author, slug, "Hello");
  await addRevision(author, post.id, { title: "Hello", body: "Public **words**" });
  await signInAs(editor);
  const live = await publishLatest(post.id);
  return { author, editor, post, live };
}

describe("getPublishedPostBySlug", () => {
  it("returns rendered published content", async () => {
    await setupPublished();
    const result = await getPublishedPostBySlug("hello");
    expect(result).toMatchObject({ kind: "post", title: "Hello", slug: "hello" });
    expect(result?.kind === "post" && result.html).toContain("<strong>words</strong>");
  });

  it("shows the new revision after a publish invalidates the cached page", async () => {
    const { author, editor, post } = await setupPublished();
    expect(await getPublishedPostBySlug("hello")).toMatchObject({ title: "Hello" });

    await addRevision(author, post.id, { title: "Hello again", body: "Updated" });
    await signInAs(editor);
    await publishLatest(post.id);

    expect(await getPublishedPostBySlug("hello")).toMatchObject({ title: "Hello again" });
    expect((await listPublishedPosts(1)).items[0].title).toBe("Hello again");
  });

  it("resolves a slug that was cached as missing once a post is published under it", async () => {
    expect(await getPublishedPostBySlug("coming-soon")).toBeNull();

    const author = await createTestUser("author");
    const editor = await createTestUser("editor");
    const post = await makePost(author, "coming-soon", "Coming soon");
    expect(await getPublishedPostBySlug("coming-soon")).toBeNull();

    await signInAs(editor);
    await publishLatest(post.id);
    expect(await getPublishedPostBySlug("coming-soon")).toMatchObject({ title: "Coming soon" });
  });

  it("never serves draft content, even after the cache entry is gone", async () => {
    const { author, post } = await setupPublished();
    expect(await getPublishedPostBySlug("hello")).toMatchObject({ title: "Hello" });

    await signInAs(author);
    const current = await getPost(post.id);
    expectOk(
      await saveRevision({
        postId: post.id,
        expectedVersion: current.version,
        title: "Secret draft",
        body: "Not ready",
      }),
    );

    expect(await getPublishedPostBySlug("hello")).toMatchObject({ title: "Hello" });
    const { resetNextCache } = await import("./support/fake-next-cache");
    resetNextCache();
    expect(await getPublishedPostBySlug("hello")).toMatchObject({ title: "Hello" });
  });

  it("redirects an old slug and stops redirecting when the slug is taken back", async () => {
    const { editor, post } = await setupPublished("old-slug");
    expect(await getPublishedPostBySlug("old-slug")).toMatchObject({ kind: "post" });

    await signInAs(editor);
    const { version } = await getPost(post.id);
    const renamed = expectOk(
      await changeSlug({ postId: post.id, expectedVersion: version, slug: "new-slug" }),
    );

    expect(await getPublishedPostBySlug("old-slug")).toEqual({
      kind: "redirect",
      slug: "new-slug",
    });
    expect(await getPublishedPostBySlug("new-slug")).toMatchObject({ kind: "post" });

    expectOk(
      await changeSlug({ postId: post.id, expectedVersion: renamed.version, slug: "old-slug" }),
    );
    expect(await getPublishedPostBySlug("old-slug")).toMatchObject({ kind: "post" });
    expect(await getPublishedPostBySlug("new-slug")).toEqual({
      kind: "redirect",
      slug: "old-slug",
    });
  });

  it("does not redirect a slug the post never had a redirect for", async () => {
    const author = await createTestUser("author");
    const editor = await createTestUser("editor");
    const post = await makePost(author, "before-publish");
    await signInAs(author);
    expect(await getPublishedPostBySlug("before-publish")).toBeNull();
    expectOk(await changeSlug({ postId: post.id, expectedVersion: 1, slug: "after-rename" }));

    await signInAs(editor);
    await publishLatest(post.id);

    expect(await getPublishedPostBySlug("before-publish")).toBeNull();
    expect(await getPublishedPostBySlug("after-rename")).toMatchObject({ kind: "post" });
  });

  it("returns null after unpublish and after archive", async () => {
    const { editor, post, live } = await setupPublished();
    expect(await getPublishedPostBySlug("hello")).not.toBeNull();
    await signInAs(editor);

    const unpublished = expectOk(
      await unpublishPost({ postId: post.id, expectedVersion: live.version }),
    );
    expect(await getPublishedPostBySlug("hello")).toBeNull();
    expect((await listPublishedPosts(1)).items).toEqual([]);

    const again = await publishLatest(post.id);
    expect(again.version).toBe(unpublished.version + 1);
    expect(await getPublishedPostBySlug("hello")).not.toBeNull();

    expectOk(await archivePost({ postId: post.id, expectedVersion: again.version }));
    expect(await getPublishedPostBySlug("hello")).toBeNull();
    expect((await listPublishedPosts(1)).items).toEqual([]);
  });
});

describe("listPublishedPosts", () => {
  it("pages ten posts at a time, newest first", async () => {
    const author = await createTestUser("author");
    const editor = await createTestUser("editor");
    await signInAs(editor);
    for (let i = 1; i <= 12; i++) {
      const post = await makePost(author, `post-${i}`, `Post ${i}`);
      setNow(new Date(Date.UTC(2030, 0, 1, i)));
      await publishLatest(post.id);
    }

    const first = await listPublishedPosts(1);
    const second = await listPublishedPosts(2);

    expect(first.totalPages).toBe(2);
    expect(first.items).toHaveLength(10);
    expect(first.items[0].title).toBe("Post 12");
    expect(second.items.map((p) => p.title)).toEqual(["Post 2", "Post 1"]);
  });
});
