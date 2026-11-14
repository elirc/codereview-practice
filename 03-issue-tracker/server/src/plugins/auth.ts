import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { unauthenticated } from '../lib/errors.js';
import { hashToken } from '../lib/tokens.js';
import { findUserBySessionToken, type UserRow } from '../modules/auth/repo.js';

export const SESSION_COOKIE = 'it_session';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
  }
}

export function setSessionCookie(
  reply: FastifyReply,
  config: Config,
  token: string,
  expires: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    expires,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
  });
}

/** Resolves the session cookie (if any) to `request.user` on every request. */
export function registerSessionAuth(app: FastifyInstance): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const { db, clock, config } = app.deps;
    const user = await findUserBySessionToken(hashToken(token), clock.now(), db);
    if (user) {
      request.user = user;
    } else {
      clearSessionCookie(reply, config);
    }
  });
}

/** onRequest hook for scopes that require a signed-in user. */
export async function requireUser(request: FastifyRequest): Promise<void> {
  if (!request.user) {
    throw unauthenticated();
  }
}

export function currentUser(request: FastifyRequest): UserRow {
  if (!request.user) {
    throw unauthenticated();
  }
  return request.user;
}
