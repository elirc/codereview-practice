import { describe, expect, it } from "vitest";
import { duplicatePost } from "@/actions/posts";
import * as files from "../fixtures/files";
import { revalidatedTags } from "./support/fake-next-cache";
import { createTestUser, errorCode, expectOk, signInAs } from "./support/fixtures";
import { storeFile } from "./support/media";
import { addRevision, getPost, getRevisionMedia, getRevisions, makePost } from "./support/records";

describe("duplicatePost", () => {
  it("creates a draft owned by the caller from the latest revision", async () => {
    const author = await createTestUser("author");
    const cover = await storeFile(author.id, files.png());
    const source = await makePost(author, "spring-menu", "Spring menu");
    await addRevision(author, source.id, {
      title: "Spring menu",
      excerpt: "What we are cooking",
      body: `Asparagus.\n\n![plate](media:${cover.id})`,
      coverMediaId: cover.id,
    });
    await signInAs(author);

    const copy = expectOk(await duplicatePost({ postId: source.id, slug: "summer-menu" }));

    expect(copy).toMatchObject({ slug: "summer-menu", status: "draft", version: 1 });
    expect((await getPost(copy.id)).authorId).toBe(author.id);
    const [revision] = await getRevisions(copy.id);
    expect(revision).toMatchObject({
      number: 1,
      title: "Spring menu",
      excerpt: "What we are cooking",
      body: `Asparagus.\n\n![plate](media:${cover.id})`,
      coverMediaId: cover.id,
      createdBy: author.id,
      restoredFromNumber: null,
    });
    expect((await getRevisionMedia(revision.id)).map((row) => row.mediaId)).toEqual([cover.id]);
    expect(revalidatedTags).toEqual([]);
  });

  it("gives the copy to the editor who made it and leaves the source alone", async () => {
    const author = await createTestUser("author");
    const editor = await createTestUser("editor");
    const source = await makePost(author, "weekly-notes", "Weekly notes");
    await signInAs(editor);

    const copy = expectOk(await duplicatePost({ postId: source.id, slug: "weekly-notes-two" }));

    expect((await getPost(copy.id)).authorId).toBe(editor.id);
    expect(await getPost(source.id)).toMatchObject({ version: 1, status: "draft" });
    expect(await getRevisions(source.id)).toHaveLength(1);
  });

  it("refuses a slug that is already taken", async () => {
    const author = await createTestUser("author");
    const source = await makePost(author, "taken-slug");
    await signInAs(author);

    expect(errorCode(await duplicatePost({ postId: source.id, slug: "taken-slug" }))).toBe(
      "slug_taken",
    );
  });
});
