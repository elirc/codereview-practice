import type { Database } from '../../db/index.js';
import type { MembershipRole } from '../../db/types.js';

export interface UserRow {
  id: string;
  email: string;
  name: string;
}

export async function findUserCredentials(email: string, db: Database) {
  return db
    .selectFrom('users')
    .select(['id', 'email', 'name', 'password_hash'])
    .where('email', '=', email)
    .executeTakeFirst();
}

export async function insertUser(
  values: { email: string; name: string; passwordHash: string; createdAt: Date },
  db: Database,
): Promise<UserRow> {
  return db
    .insertInto('users')
    .values({
      email: values.email,
      name: values.name,
      password_hash: values.passwordHash,
      created_at: values.createdAt,
    })
    .returning(['id', 'email', 'name'])
    .executeTakeFirstOrThrow();
}

export async function insertSession(
  values: { userId: string; tokenHash: string; expiresAt: Date; createdAt: Date },
  db: Database,
): Promise<void> {
  await db
    .insertInto('sessions')
    .values({
      user_id: values.userId,
      token_hash: values.tokenHash,
      expires_at: values.expiresAt,
      created_at: values.createdAt,
    })
    .execute();
}

export async function findUserBySessionToken(
  tokenHash: string,
  now: Date,
  db: Database,
): Promise<UserRow | undefined> {
  return db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select(['u.id', 'u.email', 'u.name'])
    .where('s.token_hash', '=', tokenHash)
    .where('s.expires_at', '>', now)
    .executeTakeFirst();
}

export async function deleteSessionByTokenHash(tokenHash: string, db: Database): Promise<void> {
  await db.deleteFrom('sessions').where('token_hash', '=', tokenHash).execute();
}

export async function deleteExpiredSessions(now: Date, db: Database): Promise<number> {
  const result = await db.deleteFrom('sessions').where('expires_at', '<=', now).executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** The caller's own memberships, used to build the org switcher. */
export async function listUserMemberships(
  userId: string,
  db: Database,
): Promise<{ orgSlug: string; orgName: string; role: MembershipRole }[]> {
  return db
    .selectFrom('memberships as m')
    .innerJoin('orgs as o', 'o.id', 'm.org_id')
    .select(['o.slug as orgSlug', 'o.name as orgName', 'm.role'])
    .where('m.user_id', '=', userId)
    .orderBy('o.name')
    .orderBy('o.slug')
    .execute();
}
