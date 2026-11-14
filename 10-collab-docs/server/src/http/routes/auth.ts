import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as auth from '../../services/auth.js';
import type { ServiceContext } from '../../services/context.js';
import { listWorkspaces } from '../../services/workspaces.js';
import { clearSessionCookie, requireAuth, setSessionCookie } from '../auth.js';
import { emptyBody, validate } from '../validate.js';

const email = z.string().trim().email().max(254);

const registerBody = z
  .object({
    email,
    name: z.string().trim().min(1).max(100),
    password: z.string().min(8).max(200),
  })
  .strict();

const loginBody = z
  .object({
    email,
    password: z.string().min(1).max(200),
  })
  .strict();

export function authRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  app.post('/auth/register', async (request, reply) => {
    const input = validate(registerBody, request.body);
    const session = await auth.register(ctx, input);
    setSessionCookie(reply, ctx, session.token, session.expiresAt);
    return reply.status(201).send({ user: session.user });
  });

  app.post('/auth/login', async (request, reply) => {
    const input = validate(loginBody, request.body);
    const session = await auth.login(ctx, input);
    setSessionCookie(reply, ctx, session.token, session.expiresAt);
    return { user: session.user };
  });

  app.post('/auth/logout', async (request, reply) => {
    validate(emptyBody, request.body);
    const session = requireAuth(request);
    await auth.logout(ctx, session.sessionId);
    clearSessionCookie(reply, ctx);
    return reply.status(204).send();
  });

  app.get('/auth/me', async (request) => {
    const session = requireAuth(request);
    return { user: session.user, workspaces: await listWorkspaces(ctx, session.user.id) };
  });
}
