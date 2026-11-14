import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { deleteMedia } from "@/actions/media";
import { publishPost, schedulePost } from "@/actions/workflow";
import { GET } from "@/app/media/[id]/route";
import { db } from "@/db/client";
import { media, revisionMedia } from "@/db/schema";
import * as files from "../fixtures/files";
import {
  FIXED_NOW,
  createTestUser,
  errorCode,
  expectOk,
  secondsAfter,
  signInAs,
  signOut,
  type TestUser,
} from "./support/fixtures";
import { memoryStorage, storeFile } from "./support/media";
import { addRevision, getPost, makePost } from "./support/records";

function fetchMedia(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/media/${id}`), { params: Promise.resolve({ id }) });
}

async function draftReferencing(author: TestUser, mediaId: string, slug = "uses-media") {
  const post = await makePost(author, slug);
  const saved = await addRevision(author, post.id, { body: `![pic](media:${mediaId})` });
  return { post: saved.post, revision: saved.revision };
}

describe("GET /media/[id]", () => {
  it("returns 404 for a non-UUID id without touching storage", async () => {
    const response = await fetchMedia("../../secret");
    expect(response.status).toBe(404);
    expect(memoryStorage().calls).toEqual([]);
  });

  it("returns 404 for an unknown id", async () => {
    const response = await fetchMedia("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(response.status).toBe(404);
  });

  it("serves draft-only media to signed-in users but not to visitors", async () => {
    const author = await createTestUser("author");
    const other = await createTestUser("author");
    const stored = await storeFile(author.id, files.png());
    await draftReferencing(author, stored.id);

    expect((await fetchMedia(stored.id)).status).toBe(404);

    await signInAs(other);
    const response = await fetchMedia(stored.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(files.png());
  });

  it("serves media publicly once a revision referencing it is published", async () => {
    const author = await createTestUser("author");
    const editor = await createTestUser("editor");
    const stored = await storeFile(author.id, files.png());
    const { post, revision } = await draftReferencing(author, stored.id);

    await signInAs(editor);
    expectOk(
      await publishPost({
        postId: post.id,
        revisionId: revision.id,
        expectedVersion: post.version,
      }),
    );
    signOut();

    const response = await fetchMedia(stored.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("sends locked-down headers and a safe Content-Disposition", async () => {
    const author = await createTestUser("author");
    await signInAs(author);
    const image = await storeFile(author.id, files.png(), 'evil"\r\nX-Injected: 1.png');
    const doc = await storeFile(author.id, files.pdf(), "../../report é.pdf");

    const imageResponse = await fetchMedia(image.id);
    const docResponse = await fetchMedia(doc.id);

    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(imageResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(imageResponse.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(imageResponse.headers.get("content-disposition")).toBe(
      "inline; filename=\"evil_X-Injected: 1.png\"; filename*=UTF-8''evil%22X-Injected%3A%201.png",
    );
    expect(imageResponse.headers.get("x-injected")).toBeNull();
    expect(docResponse.headers.get("content-type")).toBe("application/pdf");
    expect(docResponse.headers.get("content-disposition")).toBe(
      "attachment; filename=\"report _.pdf\"; filename*=UTF-8''report%20%C3%A9.pdf",
    );
  });
});

describe("deleteMedia", () => {
  async function scene() {
    const author = await createTestUser("author");
    const otherAuthor = await createTestUser("author");
    const editor = await createTestUser("editor");
    const admin = await createTestUser("admin");
    return { author, otherAuthor, editor, admin };
  }

  async function exists(mediaId: string) {
    return (await db.select().from(media).where(eq(media.id, mediaId))).length === 1;
  }

  it("lets an author delete their own unreferenced media and removes the object", async () => {
    const { author } = await scene();
    const stored = await storeFile(author.id, files.png());
    await signInAs(author);

    expectOk(await deleteMedia({ mediaId: stored.id }));

    expect(await exists(stored.id)).toBe(false);
    expect(memoryStorage().objects.has(stored.storageKey)).toBe(false);
  });

  it("forbids an author from deleting someone else's media", async () => {
    const { author, otherAuthor } = await scene();
    const stored = await storeFile(otherAuthor.id, files.png());
    await signInAs(author);

    expect(errorCode(await deleteMedia({ mediaId: stored.id }))).toBe("forbidden");
    expect(await exists(stored.id)).toBe(true);
  });

  it("refuses authors and editors when any revision references the media", async () => {
    const { author, editor } = await scene();
    const stored = await storeFile(author.id, files.png());
    await draftReferencing(author, stored.id);

    await signInAs(author);
    expect(errorCode(await deleteMedia({ mediaId: stored.id }))).toBe("media_in_use");
    await signInAs(editor);
    expect(errorCode(await deleteMedia({ mediaId: stored.id }))).toBe("media_in_use");
    expect(await exists(stored.id)).toBe(true);
    expect(memoryStorage().objects.has(stored.storageKey)).toBe(true);
  });

  it("lets an editor delete anyone's unreferenced media", async () => {
    const { author, editor } = await scene();
    const stored = await storeFile(author.id, files.png());
    await signInAs(editor);
    expectOk(await deleteMedia({ mediaId: stored.id }));
    expect(await exists(stored.id)).toBe(false);
  });

  it("lets an admin delete media referenced only by drafts", async () => {
    const { author, admin } = await scene();
    const stored = await storeFile(author.id, files.png());
    const { revision } = await draftReferencing(author, stored.id);
    await signInAs(admin);

    expectOk(await deleteMedia({ mediaId: stored.id }));

    expect(await exists(stored.id)).toBe(false);
    const refs = await db
      .select()
      .from(revisionMedia)
      .where(eq(revisionMedia.revisionId, revision.id));
    expect(refs).toEqual([]);
  });

  it("refuses every role when a published or scheduled revision uses the media", async () => {
    const { author, editor, admin } = await scene();
    const published = await storeFile(author.id, files.png());
    const scheduled = await storeFile(author.id, files.gif());
    const live = await draftReferencing(author, published.id, "live-post");
    const queued = await draftReferencing(author, scheduled.id, "queued-post");

    await signInAs(editor);
    expectOk(
      await publishPost({
        postId: live.post.id,
        revisionId: live.revision.id,
        expectedVersion: live.post.version,
      }),
    );
    expectOk(
      await schedulePost({
        postId: queued.post.id,
        revisionId: queued.revision.id,
        expectedVersion: (await getPost(queued.post.id)).version,
        scheduledFor: secondsAfter(FIXED_NOW, 3600).toISOString(),
      }),
    );

    for (const actor of [author, editor, admin]) {
      await signInAs(actor);
      for (const item of [published, scheduled]) {
        expect(errorCode(await deleteMedia({ mediaId: item.id }))).toBe("media_in_use");
      }
    }
    expect(await exists(published.id)).toBe(true);
    expect(await exists(scheduled.id)).toBe(true);
  });

  it("returns not_found for unknown media", async () => {
    const { admin } = await scene();
    await signInAs(admin);
    const result = await deleteMedia({ mediaId: "0f8fad5b-d9cb-469f-a165-70867728950e" });
    expect(errorCode(result)).toBe("not_found");
  });
});
