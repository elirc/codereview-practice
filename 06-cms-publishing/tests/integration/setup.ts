import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { closeDb, db } from "@/db/client";
import { clock } from "@/services/clock";
import { resetNextCache } from "./support/fake-next-cache";
import { FIXED_NOW } from "./support/fixtures";
import { resetRequestContext } from "./support/request-context";

vi.mock("next/headers", async () => {
  const { requestContext } = await import("./support/request-context");
  return {
    cookies: async () => requestContext.cookies,
    headers: async () => requestContext.headers,
    draftMode: async () => requestContext.draftMode,
  };
});

vi.mock("next/cache", async () => {
  const fake = await import("./support/fake-next-cache");
  return {
    unstable_cache: fake.unstableCache,
    revalidateTag: fake.revalidateTag,
    revalidatePath: fake.revalidatePath,
  };
});

beforeEach(async () => {
  resetRequestContext();
  resetNextCache();
  vi.spyOn(clock, "now").mockImplementation(() => new Date(FIXED_NOW));
  await db.execute(
    sql`TRUNCATE revision_media, slug_redirects, sessions, revisions, posts, media, users RESTART IDENTITY CASCADE`,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeDb();
});
