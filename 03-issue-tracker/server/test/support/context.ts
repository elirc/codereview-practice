import { sql } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { buildApp, type App } from '../../src/app.js';
import { createDb, type Database } from '../../src/db/index.js';
import type { Clock } from '../../src/lib/clock.js';
import { hashPassword } from '../../src/lib/password.js';
import { generateSessionToken, hashToken } from '../../src/lib/tokens.js';
import { SESSION_TTL_MS } from '../../src/modules/auth/service.js';
import { SESSION_COOKIE } from '../../src/plugins/auth.js';
import { APP_ORIGIN, testConfig } from './config.js';

const START = Date.parse('2026-03-02T09:00:00.000Z');

export class TestClock implements Clock {
  private current = START;

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  reset(): void {
    this.current = START;
  }
}

const TABLES = [
  'comments',
  'issue_labels',
  'issues',
  'labels',
  'projects',
  'memberships',
  'orgs',
  'sessions',
  'users',
];

export interface TestContext {
  app: App;
  db: Database;
  clock: TestClock;
}

export async function resetDatabase(db: Database): Promise<void> {
  await sql.raw(`TRUNCATE ${TABLES.join(', ')} CASCADE`).execute(db);
}

/** Builds one app per test file and truncates the database before each test. */
export function useTestContext(): TestContext {
  const ctx = {} as TestContext;
  beforeAll(async () => {
    const config = testConfig();
    ctx.db = createDb(config.databaseUrl, 20);
    ctx.clock = new TestClock();
    ctx.app = await buildApp({ config, clock: ctx.clock, db: ctx.db });
    await ctx.app.ready();
  });
  beforeEach(async () => {
    ctx.clock.reset();
    await resetDatabase(ctx.db);
  });
  afterAll(async () => {
    await ctx.app?.close();
    await ctx.db?.destroy();
  });
  return ctx;
}

export const TEST_PASSWORD = 'correct horse battery staple';
let passwordHash: Promise<string> | undefined;

export interface TestUser {
  id: string;
  email: string;
  name: string;
  cookie: string;
}

export async function createSessionCookie(ctx: TestContext, userId: string): Promise<string> {
  const token = generateSessionToken();
  await ctx.db
    .insertInto('sessions')
    .values({
      user_id: userId,
      token_hash: hashToken(token),
      expires_at: new Date(ctx.clock.now().getTime() + SESSION_TTL_MS),
    })
    .execute();
  return `${SESSION_COOKIE}=${token}`;
}

/** Inserts a user directly (sharing one password hash) and opens a session for them. */
export async function createUser(
  ctx: TestContext,
  email: string,
  name?: string,
): Promise<TestUser> {
  passwordHash ??= hashPassword(TEST_PASSWORD);
  const user = await ctx.db
    .insertInto('users')
    .values({ email, name: name ?? email.split('@')[0], password_hash: await passwordHash })
    .returning(['id', 'email', 'name'])
    .executeTakeFirstOrThrow();
  return { ...user, cookie: await createSessionCookie(ctx, user.id) };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface CallOptions {
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Sends a request the way the web client does: JSON body and the app origin on writes. */
export function call(
  ctx: TestContext,
  method: Method,
  url: string,
  options: CallOptions = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers.origin = APP_ORIGIN;
    headers['content-type'] = 'application/json';
  }
  if (options.cookie) headers.cookie = options.cookie;
  Object.assign(headers, options.headers);
  return ctx.app.inject({
    method,
    url,
    headers,
    payload: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
  });
}

export function errorCode(res: LightMyRequestResponse): string | undefined {
  return res.json().error?.code;
}
