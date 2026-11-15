import { describe, expect, it } from "vitest";
import { deletePosts } from "@/actions/posts";
import { revalidatedTags } from "./support/fake-next-cache";
import { createTestUser, errorCode, expectOk, signInAs } from "./support/fixtures";
import { addRevision, getPost, getRevisions, makePost } from "./support/records";
import { toState } from "./support/states";

describe("deletePosts", () => {
  it("deletes several of an author's drafts with their revisions", async () => {
    const author = await createTestUser("author");
    const first = await makePost(author, "first-draft");
    const second = await makePost(author, "second-draft");
    await addRevision(author, second.id, { body: "more words" });
    await signInAs(author);

    const result = expectOk(await deletePosts({ postIds: [first.id, second.id] }));

    expect([...result.ids].sort()).toEqual([first.id, second.id].sort());
    expect(await getPost(first.id)).toBeUndefined();
    expect(await getPost(second.id)).toBeUndefined();
    expect(await getRevisions(second.id)).toEqual([]);
    expect(revalidatedTags).toEqual([]);
  });

  it("lets an admin delete a published post and invalidates its page", async () => {
    const author = await createTestUser("author");
    const editor = await createTestUser("editor");
    const admin = await createTestUser("admin");
    const live = await makePost(author, "live-post");
    const draft = await makePost(author, "quiet-draft");
    await toState.published(editor, live.id);
    await signInAs(admin);

    expectOk(await deletePosts({ postIds: [live.id, draft.id] }));

    expect([...revalidatedTags].sort()).toEqual(
      [`post:${live.id}`, "post-slug:live-post", "posts:list"].sort(),
    );
  });

  it("deletes nothing when one of the posts belongs to someone else", async () => {
    const author = await createTestUser("author");
    const other = await createTestUser("author");
    const own = await makePost(author, "mine");
    const theirs = await makePost(other, "theirs");
    await signInAs(author);

    expect(errorCode(await deletePosts({ postIds: [own.id, theirs.id] }))).toBe("not_found");
    expect(await getPost(own.id)).toBeDefined();
    expect(await getPost(theirs.id)).toBeDefined();
  });
});
