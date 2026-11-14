import type { AppDeps } from '../../app.js';
import { isUniqueViolation } from '../../db/index.js';
import { AppError, conflict } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { generateSessionToken, hashToken } from '../../lib/tokens.js';
import {
  deleteSessionByTokenHash,
  findUserCredentials,
  insertSession,
  insertUser,
  listUserMemberships,
  type UserRow,
} from './repo.js';

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type Deps = Pick<AppDeps, 'db' | 'clock'>;

export interface StartedSession {
  user: UserRow;
  token: string;
  expiresAt: Date;
}

let dummyHash: Promise<string> | undefined;

// Login against an unknown email still pays for one scrypt derivation.
function timingDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('placeholder-password-for-timing');
  return dummyHash;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function startSession(deps: Deps, user: UserRow): Promise<StartedSession> {
  const now = deps.clock.now();
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await insertSession(
    { userId: user.id, tokenHash: hashToken(token), expiresAt, createdAt: now },
    deps.db,
  );
  return { user, token, expiresAt };
}

export async function register(
  deps: Deps,
  input: { email: string; name: string; password: string },
): Promise<StartedSession> {
  const passwordHash = await hashPassword(input.password);
  let user: UserRow;
  try {
    user = await insertUser(
      {
        email: normalizeEmail(input.email),
        name: input.name.trim(),
        passwordHash,
        createdAt: deps.clock.now(),
      },
      deps.db,
    );
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_key')) {
      throw conflict('email_taken', 'An account with this email already exists.');
    }
    throw err;
  }
  return startSession(deps, user);
}

export async function login(
  deps: Deps,
  input: { email: string; password: string },
): Promise<StartedSession> {
  const credentials = await findUserCredentials(normalizeEmail(input.email), deps.db);
  const valid = await verifyPassword(
    input.password,
    credentials?.password_hash ?? (await timingDummyHash()),
  );
  if (!credentials || !valid) {
    throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
  }
  return startSession(deps, { id: credentials.id, email: credentials.email, name: credentials.name });
}

export async function logout(deps: Deps, token: string | undefined): Promise<void> {
  if (token) {
    await deleteSessionByTokenHash(hashToken(token), deps.db);
  }
}

export async function describeUser(deps: Deps, user: UserRow) {
  const memberships = await listUserMemberships(user.id, deps.db);
  return { user: { id: user.id, email: user.email, name: user.name }, memberships };
}
