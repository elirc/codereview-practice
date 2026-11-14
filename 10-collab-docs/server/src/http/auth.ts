import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { findSession, type AuthSession } from '../services/auth.js';
import type { ServiceContext } from '../services/context.js';
import { errors } from './errors.js';

export const SESSION_COOKIE = 'cd_session';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthSession | null;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isJson(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

/** Adds the API scope's request hooks and the `request.auth` decorator. */
export function registerAuth(app: FastifyInstance, ctx: ServiceContext): void {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request) => {
    if (!MUTATING.has(request.method)) return;
    if (!isJson(request.headers['content-type']) || request.headers.origin !== ctx.config.APP_ORIGIN) {
      throw errors.forbidden('Cross-origin or non-JSON request refused.');
    }
  });

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    request.auth = token ? await findSession(ctx.db, token, ctx.clock.now()) : null;
  });
}

/** Returns the signed-in session or throws `unauthenticated`. */
export function requireAuth(request: FastifyRequest): AuthSession {
  if (!request.auth) throw errors.unauthenticated();
  return request.auth;
}

/** Sets the session cookie on a response. */
export function setSessionCookie(
  reply: FastifyReply,
  ctx: ServiceContext,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.NODE_ENV === 'production',
    expires: expiresAt,
  });
}

/** Clears the session cookie on a response. */
export function clearSessionCookie(reply: FastifyReply, ctx: ServiceContext): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.NODE_ENV === 'production',
  });
}

/** Parses a raw Cookie header into name/value pairs. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
}
