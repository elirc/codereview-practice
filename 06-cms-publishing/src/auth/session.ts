import { createHash, randomBytes } from "node:crypto";
import { eq, lte } from "drizzle-orm";
import { db, type Executor } from "@/db/client";
import { sessions, users, type Role } from "@/db/schema";
import { getEnv } from "@/env";

export const SESSION_COOKIE = "cms_session";
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type SessionUser = { id: string; email: string; name: string; role: Role };

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    createdAt: now,
  });
  return { token, expiresAt };
}

/** Resolves a raw session token to its user, or null if unknown, expired or deactivated. */
export async function findSessionUser(token: string, now: Date): Promise<SessionUser | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      active: users.active,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashSessionToken(token)))
    .limit(1);

  if (!row || !row.active || row.expiresAt.getTime() <= now.getTime()) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export async function deleteSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
}

export async function deleteSessionsForUser(executor: Executor, userId: string): Promise<void> {
  await executor.delete(sessions).where(eq(sessions.userId, userId));
}

export async function deleteExpiredSessions(now: Date): Promise<void> {
  await db.delete(sessions).where(lte(sessions.expiresAt, now));
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: getEnv().NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}
