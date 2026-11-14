import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Principal, UserPrincipal } from '../services/access.js';
import { requireAuth } from './auth.js';
import { validate } from './validate.js';

const linkQuery = z.object({ link: z.string().min(1).max(200).optional() }).strict();

function linkFrom(request: FastifyRequest): string | undefined {
  return validate(linkQuery, request.query ?? {}).link;
}

/** Returns the caller as a principal: their session (if any) plus an optional `?link=` token. */
export function principalOf(request: FastifyRequest): Principal {
  const link = linkFrom(request);
  return { userId: request.auth?.user.id ?? null, link: link ? { token: link } : null };
}

/** Like `principalOf`, but requires a session. */
export function userPrincipalOf(request: FastifyRequest): UserPrincipal {
  const link = linkFrom(request);
  const session = requireAuth(request);
  return { userId: session.user.id, link: link ? { token: link } : null };
}
