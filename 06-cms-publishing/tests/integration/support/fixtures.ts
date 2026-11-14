import { vi } from "vitest";
import { hashPassword } from "@/auth/password";
import { SESSION_COOKIE, createSession, type SessionUser } from "@/auth/session";
import { db } from "@/db/client";
import { users, type Role } from "@/db/schema";
import { clock } from "@/services/clock";
import { requestContext } from "./request-context";

export const FIXED_NOW = "2030-01-15T10:00:00.000Z";
export const TEST_PASSWORD = "correct horse battery staple";

let passwordHash: Promise<string> | undefined;
let counter = 0;

export type TestUser = SessionUser & { active: boolean };

export async function createTestUser(
  role: Role,
  overrides: { name?: string; email?: string; active?: boolean } = {},
): Promise<TestUser> {
  passwordHash ??= hashPassword(TEST_PASSWORD);
  counter += 1;
  const [user] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `${role}${counter}@example.test`,
      name: overrides.name ?? `${role} ${counter}`,
      role,
      active: overrides.active ?? true,
      passwordHash: await passwordHash,
    })
    .returning();
  return { id: user.id, email: user.email, name: user.name, role: user.role, active: user.active };
}

/** Creates a real session for the user and puts its token in the stubbed request cookies. */
export async function signInAs(user: { id: string }): Promise<string> {
  const { token } = await createSession(user.id, clock.now());
  requestContext.cookies.set(SESSION_COOKIE, token);
  return token;
}

export function signOut(): void {
  requestContext.cookies.delete(SESSION_COOKIE);
}

export function setNow(iso: string | Date): Date {
  const now = new Date(iso);
  vi.spyOn(clock, "now").mockImplementation(() => new Date(now));
  return now;
}

export function secondsAfter(base: string | Date, seconds: number): Date {
  return new Date(new Date(base).getTime() + seconds * 1000);
}

/** Narrows an action result to its success branch, failing the test with the error otherwise. */
export function expectOk<T>(
  result: { ok: true; data: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) {
    throw new Error(`Expected success, got ${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

export function errorCode(
  result: { ok: true } | { ok: false; error: { code: string } },
): string | null {
  return result.ok ? null : result.error.code;
}
