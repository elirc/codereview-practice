import { afterAll, beforeEach, vi } from "vitest";
import { db } from "@/server/db";
import { jobs } from "@/server/jobs";
import { resetDatabase } from "./helpers";

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(jobs, "publish").mockResolvedValue(undefined);
  await resetDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});
