import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { EmptyBody } from '../../lib/schemas.js';
import {
  clearSessionCookie,
  currentUser,
  requireUser,
  SESSION_COOKIE,
  setSessionCookie,
} from '../../plugins/auth.js';
import { LoginBody, MeResponse, RegisterBody } from './schemas.js';
import { describeUser, login, logout, register } from './service.js';

export const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { deps } = app;

  app.post(
    '/auth/register',
    { schema: { body: RegisterBody, response: { 201: MeResponse } } },
    async (request, reply) => {
      const session = await register(deps, request.body);
      setSessionCookie(reply, deps.config, session.token, session.expiresAt);
      reply.code(201);
      return { user: session.user, memberships: [] };
    },
  );

  app.post(
    '/auth/login',
    { schema: { body: LoginBody, response: { 200: MeResponse } } },
    async (request, reply) => {
      const session = await login(deps, request.body);
      setSessionCookie(reply, deps.config, session.token, session.expiresAt);
      return describeUser(deps, session.user);
    },
  );

  app.post(
    '/auth/logout',
    { schema: { body: EmptyBody, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await logout(deps, request.cookies[SESSION_COOKIE]);
      clearSessionCookie(reply, deps.config);
      return reply.code(204).send();
    },
  );

  app.get(
    '/auth/me',
    { onRequest: requireUser, schema: { response: { 200: MeResponse } } },
    async (request) => describeUser(deps, currentUser(request)),
  );
};
