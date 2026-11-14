import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createPost, restoreRevision, saveRevision } from "@/actions/posts";
import { db } from "@/db/client";
import { posts, revisions, slugRedirects } from "@/db/schema";
import { FIXED_NOW, createTestUser, errorCode, expectOk, signInAs } from "./support/fixtures";
import {
  addRevision,
  getPost,
  getRevisionMedia,
  getRevisions,
  insertMediaRow,
  makePost,
  snapshotPost,
} from "./support/records";

function saveInput(postId: string, expectedVersion: number, body: string, extra = {}) {
  return { postId, expectedVersion, title: "Title", excerpt: "", body, ...extra };
}

describe("createPost", () => {
  it("creates a draft with revision 1", async () => {
    const author = await createTestUser("author");
    await signInAs(author);

    const post = expectOk(await createPost({ slug: "hello-world", title: "Hello" }));

    expect(post).toMatchObject({ slug: "hello-world", status: "draft", version: 1 });
    const stored = await getRevisions(post.id);
    expect(stored.map((r) => [r.number, r.title])).toEqual([[1, "Hello"]]);
    expect(post.latestRevisionId).toBe(stored[0].id);
  });

  it("rejects a slug used by another post or by another post's redirect", async () => {
    const author = await createTestUser("author");
    await signInAs(author);
    const existing = await makePost(author, "taken");
    await db.insert(slugRedirects).values({ oldSlug: "old-name", postId: existing.id });

    expect(errorCode(await createPost({ slug: "taken", title: "Again" }))).toBe("slug_taken");
    expect(errorCode(await createPost({ slug: "old-name", title: "Again" }))).toBe("slug_taken");
    expect(await db.select().from(posts)).toHaveLength(1);
  });

  it("validates the slug format", async () => {
    const author = await createTestUser("author");
    await signInAs(author);
    for (const slug of ["Upper", "two--hyphens", "-leading", "trailing-", "", "a".repeat(121)]) {
      expect(errorCode(await createPost({ slug, title: "T" }))).toBe("validation_failed");
    }
  });
});

describe("saveRevision", () => {
  it("numbers revisions sequentially and bumps the post version", async () => {
    const author = await createTestUser("author");
    await signInAs(author);
    const post = await makePost(author, "numbered");

    const second = expectOk(await saveRevision(saveInput(post.id, 1, "two")));
    const third = expectOk(await saveRevision(saveInput(post.id, 2, "three")));

    expect([second.revisionNumber, third.revisionNumber]).toEqual([2, 3]);
    expect(third.post.version).toBe(3);
    expect(third.post.latestRevisionId).toBe(third.revisionId);
  });

  it("lets exactly one of two concurrent saves with the same version win", async () => {
    const author = await createTestUser("author");
    await signInAs(author);
    const post = await makePost(author, "race");

    const results = await Promise.all([
      saveRevision(saveInput(post.id, 1, "left")),
      saveRevision(saveInput(post.id, 1, "right")),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.map(errorCode).filter(Boolean)).toEqual(["version_conflict"]);
    expect((await getRevisions(post.id)).map((r) => r.number)).toEqual([1, 2]);
    expect((await getPost(post.id)).version).toBe(2);
  });

  it("keeps numbering unique when many saves are serialised", async () => {
    const author = await createTestUser("author");
    await signInAs(author);
    const post = await makePost(author, "serial");

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        (async () => {
          for (;;) {
            const current = await getPost(post.id);
            const result = await saveRevision(saveInput(post.id, current.version, `body ${i}`));
            if (result.ok) return;
            expect(result.error.code).toBe("version_conflict");
          }
        })(),
      ),
    );

    expect((await getRevisions(post.id)).map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("describes the conflict", async () => {
    const author = await createTestUser("author", { name: "Ada" });
    await signInAs(author);
    const post = await makePost(author, "conflict");
    expectOk(await saveRevision(saveInput(post.id, 1, "newer")));

    const stale = await saveRevision(saveInput(post.id, 1, "stale"));

    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error).toMatchObject({
      code: "version_conflict",
      details: {
        currentVersion: 2,
        latestRevisionNumber: 2,
        savedBy: { id: author.id, name: "Ada" },
      },
    });
  });

  it("does nothing when the content matches the latest revision", async () => {
    const author = await createTestUser("author");
    await signInAs(author);
    const post = await makePost(author, "noop");
    const first = expectOk(await saveRevision(saveInput(post.id, 1, "same body")));

    const again = expectOk(await saveRevision(saveInput(post.id, 2, "same body")));

    expect(again.created).toBe(false);
    expect(again.revisionId).toBe(first.revisionId);
    expect(again.post.version).toBe(2);
    expect(await getRevisions(post.id)).toHaveLength(2);
  });

  it("records referenced media and rejects unknown references", async () => {
    const author = await createTestUser("author");
    await signInAs(author);
    const post = await makePost(author, "with-media");
    const cover = await insertMediaRow(author.id);
    const inline = await insertMediaRow(author.id);
    const missing = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    const rejected = await saveRevision(
      saveInput(post.id, 1, `![x](media:${missing})`, { coverMediaId: cover.id }),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe("invalid_media_reference");
      expect(rejected.error.details).toEqual({ missing: [missing] });
    }
    expect(await getRevisions(post.id)).toHaveLength(1);

    const saved = expectOk(
      await saveRevision(
        saveInput(post.id, 1, `![x](media:${inline.id})`, { coverMediaId: cover.id }),
      ),
    );
    const refs = await getRevisionMedia(saved.revisionId);
    expect(refs.map((r) => r.mediaId).sort()).toEqual([cover.id, inline.id].sort());
  });

  it("rejects an unknown cover id", async () => {
    const author = await createTestUser("author");
    await signInAs(author);
    const post = await makePost(author, "bad-cover");
    const result = await saveRevision(
      saveInput(post.id, 1, "text", { coverMediaId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
    );
    expect(errorCode(result)).toBe("invalid_media_reference");
  });

  it("hides another author's post as not_found and changes nothing", async () => {
    const owner = await createTestUser("author");
    const intruder = await createTestUser("author");
    const post = await makePost(owner, "private");
    const before = await snapshotPost(post.id);

    await signInAs(intruder);
    const result = await saveRevision(saveInput(post.id, 1, "hijack"));

    expect(errorCode(result)).toBe("not_found");
    expect(await snapshotPost(post.id)).toEqual(before);
  });

  it("forbids an author from saving their archived post but lets an editor", async () => {
    const author = await createTestUser("author");
    const editor = await createTestUser("editor");
    const post = await makePost(author, "archived-one");
    await db.update(posts).set({ status: "archived" }).where(eq(posts.id, post.id));

    await signInAs(author);
    expect(errorCode(await saveRevision(saveInput(post.id, 1, "nope")))).toBe("forbidden");

    await signInAs(editor);
    expectOk(await saveRevision(saveInput(post.id, 1, "editor fix")));
  });

  it("requires a session", async () => {
    const author = await createTestUser("author");
    const post = await makePost(author, "anon");
    expect(errorCode(await saveRevision(saveInput(post.id, 1, "x")))).toBe("unauthenticated");
  });
});

describe("restoreRevision", () => {
  it("copies an old revision into a new one without touching the published revision", async () => {
    const author = await createTestUser("author");
    await signInAs(author);
    const post = await makePost(author, "restore-me");
    for (let n = 2; n <= 7; n++) await addRevision(author, post.id, { body: `body ${n}` });
    const history = await getRevisions(post.id);
    const published = history[4];
    await db
      .update(posts)
      .set({
        status: "published",
        publishedRevisionId: published.id,
        publishedAt: new Date(FIXED_NOW),
      })
      .where(eq(posts.id, post.id));
    const current = await getPost(post.id);

    const restored = expectOk(
      await restoreRevision({
        postId: post.id,
        revisionId: history[1].id,
        expectedVersion: current.version,
      }),
    );

    expect(restored.revisionNumber).toBe(8);
    const all = await getRevisions(post.id);
    expect(all[7]).toMatchObject({ number: 8, restoredFromNumber: 2, body: "body 2" });
    const after = await getPost(post.id);
    expect(after.publishedRevisionId).toBe(published.id);
    expect(after.latestRevisionId).toBe(all[7].id);
  });

  it("rejects a revision of a different post", async () => {
    const author = await createTestUser("author");
    await signInAs(author);
    const post = await makePost(author, "target");
    const other = await makePost(author, "other");

    const result = await restoreRevision({
      postId: post.id,
      revisionId: other.latestRevisionId!,
      expectedVersion: 1,
    });

    expect(errorCode(result)).toBe("invalid_revision");
    expect(await getRevisions(post.id)).toHaveLength(1);
  });
});

describe("revision immutability", () => {
  it("rejects UPDATE on revisions at the database level", async () => {
    const author = await createTestUser("author");
    const post = await makePost(author, "immutable");
    await expect(
      db.update(revisions).set({ title: "edited" }).where(eq(revisions.postId, post.id)),
    ).rejects.toThrow(/immutable/);
    await expect(db.execute(sql`UPDATE revisions SET body = 'x'`)).rejects.toThrow(/immutable/);
  });
});
