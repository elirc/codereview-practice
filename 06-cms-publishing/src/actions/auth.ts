"use server";

import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  sessionCookieOptions,
} from "@/auth/session";
import { clock } from "@/services/clock";
import { DomainError } from "@/services/errors";
import { authenticate } from "@/services/users";
import { runAction, type ActionResult } from "./result";
import { loginSchema } from "./schemas";

export async function login(input: unknown): Promise<ActionResult<{ redirectTo: string }>> {
  return runAction("login", async () => {
    const { email, password } = loginSchema.parse(input);
    const user = await authenticate(email, password);
    if (!user) throw new DomainError("invalid_credentials", "Email or password is incorrect.");

    const now = clock.now();
    const cookieStore = await cookies();
    const previous = cookieStore.get(SESSION_COOKIE)?.value;
    if (previous) await deleteSession(previous);
    await deleteExpiredSessions(now);

    const { token, expiresAt } = await createSession(user.id, now);
    cookieStore.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
    return { redirectTo: "/admin/posts" };
  });
}

export async function logout(): Promise<ActionResult<{ redirectTo: string }>> {
  return runAction("logout", async () => {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    if (token) await deleteSession(token);
    cookieStore.delete(SESSION_COOKIE);
    return { redirectTo: "/admin/login" };
  });
}
