import { cookies } from "next/headers";
import { clock } from "@/services/clock";
import { DomainError } from "@/services/errors";
import { SESSION_COOKIE, findSessionUser, type SessionUser } from "./session";

/** The signed-in user for the current request, or null. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return findSessionUser(token, clock.now());
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new DomainError("unauthenticated", "Sign in to continue.");
  return user;
}
