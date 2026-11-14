import type { Db } from '../db/db.js';
import { isUniqueViolation } from '../db/db.js';
import { errors } from '../http/errors.js';
import { addDays } from '../lib/clock.js';
import { sha256Hex } from '../lib/random.js';
import type { ServiceContext } from './context.js';
import { hashPassword, placeholderHash, verifyPassword } from './passwords.js';

export const SESSION_TTL_DAYS = 14;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthSession {
  sessionId: string;
  expiresAt: Date;
  user: SessionUser;
}

export interface IssuedSession {
  user: SessionUser;
  token: string;
  expiresAt: Date;
}

export interface RegisterInput {
  email: string;
  name: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

function personalWorkspaceName(name: string): string {
  return `${name}'s workspace`.slice(0, 100);
}

async function issueSession(db: Db, ctx: ServiceContext, user: SessionUser): Promise<IssuedSession> {
  const token = ctx.random.token();
  const now = ctx.clock.now();
  const expiresAt = addDays(now, SESSION_TTL_DAYS);
  await db
    .insertInto('sessions')
    .values({ user_id: user.id, token_hash: sha256Hex(token), expires_at: expiresAt, created_at: now })
    .execute();
  return { user, token, expiresAt };
}

/** Creates a user with a personal workspace they own, and signs them in. */
export async function register(ctx: ServiceContext, input: RegisterInput): Promise<IssuedSession> {
  const email = input.email.toLowerCase();
  const passwordHash = await hashPassword(input.password);
  const now = ctx.clock.now();
  try {
    return await ctx.db.transaction().execute(async (trx) => {
      const user = await trx
        .insertInto('users')
        .values({ email, name: input.name, password_hash: passwordHash, created_at: now })
        .returning(['id', 'email', 'name'])
        .executeTakeFirstOrThrow();
      const workspace = await trx
        .insertInto('workspaces')
        .values({ name: personalWorkspaceName(input.name), created_at: now, updated_at: now })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('workspace_members')
        .values({ workspace_id: workspace.id, user_id: user.id, role: 'owner', created_at: now })
        .execute();
      return issueSession(trx, ctx, user);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'users_email_key')) {
      throw errors.invalidState('An account with this email already exists.');
    }
    throw error;
  }
}

/** Verifies credentials and opens a new session. */
export async function login(ctx: ServiceContext, input: LoginInput): Promise<IssuedSession> {
  const user = await ctx.db
    .selectFrom('users')
    .select(['id', 'email', 'name', 'password_hash'])
    .where('email', '=', input.email.toLowerCase())
    .executeTakeFirst();
  const matches = await verifyPassword(input.password, user?.password_hash ?? (await placeholderHash()));
  if (!user || !matches) throw errors.invalidCredentials();
  return issueSession(ctx.db, ctx, { id: user.id, email: user.email, name: user.name });
}

/** Ends a session and announces it so open sockets using it are closed. */
export async function logout(ctx: ServiceContext, sessionId: string): Promise<void> {
  await ctx.db.deleteFrom('sessions').where('id', '=', sessionId).execute();
  ctx.notifier.control({ kind: 'session_ended', sessionId });
}

/** Returns the unexpired session for a raw cookie token, or null. */
export async function findSession(db: Db, token: string, now: Date): Promise<AuthSession | null> {
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'sessions.id as session_id',
      'sessions.expires_at',
      'users.id as user_id',
      'users.email',
      'users.name',
    ])
    .where('sessions.token_hash', '=', sha256Hex(token))
    .where('sessions.expires_at', '>', now)
    .executeTakeFirst();
  if (!row) return null;
  return {
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    user: { id: row.user_id, email: row.email, name: row.name },
  };
}
