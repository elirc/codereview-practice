import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { login, logout } from "@/actions/auth";
import { createUser, updateUser } from "@/actions/users";
import { getCurrentUser, requireUser } from "@/auth/current-user";
import { SESSION_COOKIE, hashSessionToken } from "@/auth/session";
import { db } from "@/db/client";
import { sessions, users } from "@/db/schema";
import {
  FIXED_NOW,
  TEST_PASSWORD,
  createTestUser,
  errorCode,
  expectOk,
  setNow,
  signInAs,
} from "./support/fixtures";
import { requestContext } from "./support/request-context";

describe("login and logout", () => {
  it("sets an HttpOnly session cookie and stores only the token hash", async () => {
    const user = await createTestUser("author", { email: "writer@example.test" });

    const result = await login({ email: "Writer@Example.test", password: TEST_PASSWORD });
    expect(expectOk(result).redirectTo).toBe("/admin/posts");

    const token = requestContext.cookies.get(SESSION_COOKIE)?.value;
    expect(token).toBeDefined();
    expect(requestContext.cookies.lastOptions.get(SESSION_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });

    const stored = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).toBe(hashSessionToken(token!));
    expect(stored[0].tokenHash).not.toBe(token);
    expect(stored[0].expiresAt.toISOString()).toBe("2030-01-29T10:00:00.000Z");
  });

  it("rejects a wrong password and an unknown email with the same error", async () => {
    await createTestUser("author", { email: "writer@example.test" });

    const wrong = await login({ email: "writer@example.test", password: "not the password" });
    const unknown = await login({ email: "nobody@example.test", password: TEST_PASSWORD });

    expect(errorCode(wrong)).toBe("invalid_credentials");
    expect(errorCode(unknown)).toBe("invalid_credentials");
    expect(requestContext.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it("refuses to sign in a deactivated user", async () => {
    await createTestUser("editor", { email: "gone@example.test", active: false });
    const result = await login({ email: "gone@example.test", password: TEST_PASSWORD });
    expect(errorCode(result)).toBe("invalid_credentials");
  });

  it("logout deletes the session row and the cookie", async () => {
    const user = await createTestUser("author");
    await signInAs(user);

    expectOk(await logout());

    expect(requestContext.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
  });
});

describe("session validation", () => {
  it("rejects an existing session once the user is deactivated", async () => {
    const admin = await createTestUser("admin");
    const author = await createTestUser("author");
    const authorToken = await signInAs(author);
    expect((await requireUser()).id).toBe(author.id);

    await signInAs(admin);
    expectOk(await updateUser({ userId: author.id, active: false }));

    requestContext.cookies.set(SESSION_COOKIE, authorToken);
    expect(await getCurrentUser()).toBeNull();
    await expect(requireUser()).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects a session after it expires", async () => {
    const author = await createTestUser("author");
    await signInAs(author);
    setNow(new Date(new Date(FIXED_NOW).getTime() + 14 * 24 * 60 * 60 * 1000));
    expect(await getCurrentUser()).toBeNull();
  });

  it("rejects an unknown token", async () => {
    requestContext.cookies.set(SESSION_COOKIE, "made-up-token");
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("user management", () => {
  it("lets an admin create a user with a lower-cased email", async () => {
    const admin = await createTestUser("admin");
    await signInAs(admin);

    const created = expectOk(
      await createUser({
        email: "New.Editor@Example.test",
        name: "New Editor",
        role: "editor",
        password: "a-long-enough-password",
      }),
    );

    expect(created.email).toBe("new.editor@example.test");
    expect(created).not.toHaveProperty("passwordHash");
  });

  it("reports a duplicate email", async () => {
    const admin = await createTestUser("admin", { email: "admin@example.test" });
    await signInAs(admin);
    const result = await createUser({
      email: "ADMIN@example.test",
      name: "Copy",
      role: "author",
      password: "a-long-enough-password",
    });
    expect(errorCode(result)).toBe("email_taken");
  });

  it.each(["author", "editor"] as const)("forbids a %s from managing users", async (role) => {
    const actor = await createTestUser(role);
    const target = await createTestUser("author");
    await signInAs(actor);

    const created = await createUser({
      email: "sneaky@example.test",
      name: "Sneaky",
      role: "admin",
      password: "a-long-enough-password",
    });
    const updated = await updateUser({ userId: target.id, role: "admin" });

    expect(errorCode(created)).toBe("forbidden");
    expect(errorCode(updated)).toBe("forbidden");
    const [row] = await db.select().from(users).where(eq(users.id, target.id));
    expect(row.role).toBe("author");
    expect(await db.select().from(users).where(eq(users.email, "sneaky@example.test"))).toEqual(
      [],
    );
  });

  it("requires a session", async () => {
    const result = await createUser({
      email: "anon@example.test",
      name: "Anon",
      role: "admin",
      password: "a-long-enough-password",
    });
    expect(errorCode(result)).toBe("unauthenticated");
  });

  it("rejects unknown fields", async () => {
    const admin = await createTestUser("admin");
    await signInAs(admin);
    const result = await updateUser({ userId: admin.id, name: "Ok", passwordHash: "x" });
    expect(errorCode(result)).toBe("validation_failed");
  });
});
