import { createHash, randomBytes } from "node:crypto";
import type { DateTime } from "luxon";
import { db } from "../db";
import { env } from "../env";
import { toActor, type Actor } from "./actor";

export const SESSION_COOKIE = "cb_session";
export const SESSION_TTL_DAYS = 14;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  now: DateTime,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now.plus({ days: SESSION_TTL_DAYS }).toJSDate();
  await db.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt } });
  return { token, expiresAt };
}

export async function deleteSession(token: string): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function resolveSession(
  token: string | undefined,
  now: DateTime,
): Promise<Actor | null> {
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { patient: true, provider: true } } },
  });
  if (!session || session.expiresAt.getTime() <= now.toMillis()) return null;
  return toActor(session.user);
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
