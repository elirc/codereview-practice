import { afterAll, beforeEach, vi } from "vitest";
import { db } from "@/server/db";
import { resetDatabase } from "./helpers";

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});
