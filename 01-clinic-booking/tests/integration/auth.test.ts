import { describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as register } from "@/app/api/auth/register/route";
import { db } from "@/server/db";
import { call, freezeTime } from "./helpers";

const REGISTER = "/api/auth/register";

const registration = {
  email: "Ana.Silva@Example.com",
  password: "a-long-password",
  fullName: "Ana Silva",
  timezone: "Asia/Tokyo",
};

function sessionToken(setCookie: string | null): string {
  const match = /cb_session=([^;]*)/.exec(setCookie ?? "");
  if (!match) throw new Error("no session cookie");
  return match[1];
}

describe("auth API", () => {
  it("registers a patient, stores the email lower-case and starts a session", async () => {
    freezeTime("2026-06-01T12:00:00Z");
    const res = await call(register, { method: "POST", path: REGISTER, body: registration });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: "ana.silva@example.com",
      role: "PATIENT",
      patient: { fullName: "Ana Silva", timezone: "Asia/Tokyo" },
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);

    const session = await db.session.findFirstOrThrow();
    const token = sessionToken(cookie);
    expect(session.tokenHash).not.toBe(token);
    expect(session.expiresAt.toISOString()).toBe("2026-06-15T12:00:00.000Z");

    const profile = await call(me, { path: "/api/auth/me", token });
    expect(profile.status).toBe(200);
    expect(profile.body.user.email).toBe("ana.silva@example.com");
  });

  it("rejects an unknown time zone with validation_failed", async () => {
    const res = await call(register, {
      method: "POST",
      path: REGISTER,
      body: { ...registration, timezone: "Mars/Olympus_Mons" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_failed");
    const fields = res.body.error.details.fields;
    expect(fields).toEqual([expect.objectContaining({ path: "timezone" })]);
    expect(typeof res.body.error.requestId).toBe("string");
  });

  it("rejects unknown fields and short passwords", async () => {
    const res = await call(register, {
      method: "POST",
      path: REGISTER,
      body: { ...registration, password: "short", role: "ADMIN" },
    });
    expect(res.status).toBe(400);
    const paths = res.body.error.details.fields.map((f: { path: string }) => f.path);
    expect(paths).toContain("password");
    expect(paths).toContain("");
  });

  it("refuses a second account for the same email regardless of case", async () => {
    await call(register, { method: "POST", path: REGISTER, body: registration });
    const res = await call(register, {
      method: "POST",
      path: REGISTER,
      body: { ...registration, email: "ANA.SILVA@example.com" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("email_taken");
  });

  it("answers wrong passwords and unknown emails with the same 401", async () => {
    await call(register, { method: "POST", path: REGISTER, body: registration });

    const wrongPassword = await call(login, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: registration.email, password: "not-the-password" },
    });
    const unknownEmail = await call(login, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: "nobody@example.com", password: "not-the-password" },
    });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("invalid_credentials");
      expect(res.body.error.message).toBe(wrongPassword.body.error.message);
    }
  });

  it("logs in, and logout revokes the session", async () => {
    await call(register, { method: "POST", path: REGISTER, body: registration });
    const res = await call(login, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: registration.email, password: registration.password },
    });
    expect(res.status).toBe(200);
    const token = sessionToken(res.headers.get("set-cookie"));

    const out = await call(logout, { method: "POST", path: "/api/auth/logout", token });
    expect(out.status).toBe(200);

    const after = await call(me, { path: "/api/auth/me", token });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("unauthenticated");
  });

  it("treats an expired session as unauthenticated", async () => {
    freezeTime("2026-06-01T12:00:00Z");
    const res = await call(register, { method: "POST", path: REGISTER, body: registration });
    const token = sessionToken(res.headers.get("set-cookie"));

    freezeTime("2026-06-15T12:00:00Z");
    const after = await call(me, { path: "/api/auth/me", token });
    expect(after.status).toBe(401);
  });

  it("rejects mutating requests from another origin or without a JSON content type", async () => {
    const foreign = await call(login, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: registration.email, password: registration.password },
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe("csrf_failed");

    const form = await call(login, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: registration.email, password: registration.password },
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(403);
    expect(form.body.error.code).toBe("csrf_failed");
  });

  it("echoes an inbound request id in the header and the error envelope", async () => {
    const res = await call(me, { path: "/api/auth/me", headers: { "x-request-id": "req-123" } });
    expect(res.headers.get("x-request-id")).toBe("req-123");
    expect(res.body.error.requestId).toBe("req-123");
  });
});
