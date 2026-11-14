import { z } from "zod";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { json, readJson, route } from "@/server/http";
import { email, ianaZone, password } from "@/server/validation";
import { getProfile, registerPatient } from "@/services/auth";

const registerBody = z
  .object({
    email,
    password,
    fullName: z.string().trim().min(1).max(200),
    timezone: ianaZone,
    phone: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export const POST = route(async ({ req }) => {
  const input = await readJson(req, registerBody);
  const result = await registerPatient(input, clock.now());
  const response = json({ user: await getProfile(result.actor) }, 201);
  response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  return response;
});
