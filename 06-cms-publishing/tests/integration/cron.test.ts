import { describe, expect, it } from "vitest";
import { cancelSchedule, schedulePost } from "@/actions/workflow";
import { POST } from "@/app/api/internal/cron/publish/route";
import { clearRevalidations, revalidatedTags } from "./support/fake-next-cache";
import {
  FIXED_NOW,
  createTestUser,
  expectOk,
  secondsAfter,
  setNow,
  signInAs,
  type TestUser,
} from "./support/fixtures";
import { addRevision, getPost, makePost } from "./support/records";

const SECRET = process.env.CRON_SECRET!;

function cronRequest(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request("http://localhost/api/internal/cron/publish", { method: "POST", headers });
}

async function tick(): Promise<{ status: number; body: { published?: string[] } }> {
  const response = await POST(cronRequest(`Bearer ${SECRET}`));
  return { status: response.status, body: await response.json() };
}

async function scheduledPost(author: TestUser, slug: string, inSeconds: number) {
  const post = await makePost(author, slug, `Title ${slug}`);
  const scheduled = expectOk(
    await schedulePost({
      postId: post.id,
      revisionId: post.latestRevisionId!,
      expectedVersion: post.version,
      scheduledFor: secondsAfter(FIXED_NOW, inSeconds).toISOString(),
    }),
  );
  return { post, scheduled };
}

async function actors() {
  const author = await createTestUser("author");
  const editor = await createTestUser("editor");
  await signInAs(editor);
  return { author, editor };
}

describe("cron publish authentication", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["wrong scheme", `Basic ${SECRET}`],
    ["wrong secret", `Bearer ${"x".repeat(SECRET.length)}`],
    ["shorter secret", "Bearer short"],
    ["longer secret", `Bearer ${SECRET}${SECRET}`],
  ])("rejects a %s secret with 401", async (_label, header) => {
    const { author } = await actors();
    const { post } = await scheduledPost(author, "due-post", 60);
    setNow(secondsAfter(FIXED_NOW, 120));

    const response = await POST(cronRequest(header));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect((await getPost(post.id)).status).toBe("scheduled");
  });

  it("is not satisfied by an editor session", async () => {
    await actors();
    const response = await POST(cronRequest());
    expect(response.status).toBe(401);
  });
});

describe("cron publish", () => {
  it("publishes only due posts, using the actual time as publishedAt", async () => {
    const { author } = await actors();
    const due = await scheduledPost(author, "due", 60);
    const later = await scheduledPost(author, "later", 3600);
    const now = setNow(secondsAfter(FIXED_NOW, 300));

    const { status, body } = await tick();

    expect(status).toBe(200);
    expect(body.published).toEqual([due.post.id]);
    const published = await getPost(due.post.id);
    expect(published).toMatchObject({
      status: "published",
      publishedRevisionId: due.post.latestRevisionId,
      scheduledFor: null,
      scheduledRevisionId: null,
    });
    expect(published.publishedAt?.toISOString()).toBe(now.toISOString());
    expect((await getPost(later.post.id)).status).toBe("scheduled");
    expect([...revalidatedTags].sort()).toEqual(
      [`post:${due.post.id}`, "post-slug:due", "posts:list"].sort(),
    );
  });

  it("publishes the pinned revision, not the latest one", async () => {
    const { author } = await actors();
    const { post } = await scheduledPost(author, "pinned", 60);
    const newer = await addRevision(author, post.id, { body: "written after scheduling" });
    setNow(secondsAfter(FIXED_NOW, 61));

    await tick();

    const published = await getPost(post.id);
    expect(published.publishedRevisionId).toBe(post.latestRevisionId);
    expect(published.latestRevisionId).toBe(newer.revision.id);
  });

  it("skips posts whose schedule was cancelled or moved to the future", async () => {
    const { author } = await actors();
    const cancelled = await scheduledPost(author, "cancelled", 60);
    const moved = await scheduledPost(author, "moved", 60);
    expectOk(
      await cancelSchedule({
        postId: cancelled.post.id,
        expectedVersion: cancelled.scheduled.version,
      }),
    );
    expectOk(
      await schedulePost({
        postId: moved.post.id,
        revisionId: moved.post.latestRevisionId!,
        expectedVersion: moved.scheduled.version,
        scheduledFor: secondsAfter(FIXED_NOW, 7200).toISOString(),
      }),
    );
    setNow(secondsAfter(FIXED_NOW, 120));

    const { body } = await tick();

    expect(body.published).toEqual([]);
    expect((await getPost(cancelled.post.id)).status).toBe("draft");
    expect((await getPost(moved.post.id)).status).toBe("scheduled");
  });

  it("catches up on many overdue posts in one call", async () => {
    const { author } = await actors();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const { post } = await scheduledPost(author, `overdue-${i}`, 60 + i);
      ids.push(post.id);
    }
    setNow(secondsAfter(FIXED_NOW, 86_400));

    const { body } = await tick();

    expect(body.published).toHaveLength(25);
    expect([...(body.published ?? [])].sort()).toEqual([...ids].sort());
    expect(body.published?.slice(0, 3)).toEqual(ids.slice(0, 3));
    const second = await tick();
    expect(second.body.published).toEqual([]);
  });

  it("publishes each post exactly once when calls overlap", async () => {
    const { author } = await actors();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const { post } = await scheduledPost(author, `overlap-${i}`, 60);
      ids.push(post.id);
    }
    setNow(secondsAfter(FIXED_NOW, 600));
    clearRevalidations();

    const results = await Promise.all([tick(), tick(), tick()]);

    const all = results.flatMap((result) => result.body.published ?? []);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(all).toHaveLength(30);
    expect(new Set(all).size).toBe(30);
    for (const id of ids) {
      expect(revalidatedTags.filter((tag) => tag === `post:${id}`)).toHaveLength(1);
      expect((await getPost(id)).version).toBe(3);
    }
  });
});
