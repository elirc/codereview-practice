import { z } from "zod";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { json, readJson, route } from "@/server/http";
import { email } from "@/server/validation";
import { getProfile, login } from "@/services/auth";

const loginBody = z
  .object({
    email,
    password: z.string().min(1).max(200),
  })
  .strict();

export const POST = route(async ({ req }) => {
  const input = await readJson(req, loginBody);
  const result = await login(input.email, input.password, clock.now());
  const response = json({ user: await getProfile(result.actor) });
  response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  return response;
});
