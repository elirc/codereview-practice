import { asc, eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "@/auth/password";
import { deleteSessionsForUser, type SessionUser } from "@/auth/session";
import { db } from "@/db/client";
import { isUniqueViolation } from "@/db/errors";
import { users, type Role, type User } from "@/db/schema";
import { DomainError, notFoundError } from "./errors";

export type PublicUser = Pick<User, "id" | "email" | "name" | "role" | "active" | "createdAt">;

const publicColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  active: users.active,
  createdAt: users.createdAt,
};

let dummyHash: Promise<string> | undefined;

/** Checks credentials. Unknown emails still pay for a hash so response time does not reveal them. */
export async function authenticate(email: string, password: string): Promise<SessionUser | null> {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user) {
    dummyHash ??= hashPassword("not-a-real-password");
    await verifyPassword(password, await dummyHash);
    return null;
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid || !user.active) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export async function listUsers(): Promise<PublicUser[]> {
  return db.select(publicColumns).from(users).orderBy(asc(users.name));
}

export async function createUser(input: {
  email: string;
  name: string;
  role: Role;
  password: string;
}): Promise<PublicUser> {
  const passwordHash = await hashPassword(input.password);
  try {
    const [created] = await db
      .insert(users)
      .values({
        email: input.email.toLowerCase(),
        name: input.name,
        role: input.role,
        passwordHash,
      })
      .returning(publicColumns);
    return created;
  } catch (err) {
    if (isUniqueViolation(err, "users_email_unique")) {
      throw new DomainError("email_taken", "A user with this email already exists.");
    }
    throw err;
  }
}

/** Updates a user. Deactivation or a password change ends all of the user's sessions. */
export async function updateUser(input: {
  userId: string;
  name?: string;
  role?: Role;
  active?: boolean;
  password?: string;
}): Promise<PublicUser> {
  const changes: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) changes.name = input.name;
  if (input.role !== undefined) changes.role = input.role;
  if (input.active !== undefined) changes.active = input.active;
  if (input.password !== undefined) changes.passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set(changes)
      .where(eq(users.id, input.userId))
      .returning(publicColumns);
    if (!updated) throw notFoundError("User not found.");
    if (input.active === false || changes.passwordHash !== undefined) {
      await deleteSessionsForUser(tx, updated.id);
    }
    return updated;
  });
}
