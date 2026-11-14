import {
  deleteSession,
  readCookie,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/server/auth/session";
import { json, route } from "@/server/http";

export const POST = route(async ({ req }) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await deleteSession(token);
  const response = json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(new Date(0)), maxAge: 0 });
  return response;
});
