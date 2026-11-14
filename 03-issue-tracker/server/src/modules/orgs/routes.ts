import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { EmptyBody } from '../../lib/schemas.js';
import { currentUser } from '../../plugins/auth.js';
import { CreateOrgBody, Org, OrgOnlyParams, UpdateOrgBody } from './schemas.js';
import { createOrg, getOrg, removeOrg, renameOrg } from './service.js';

/** POST /orgs, which needs a signed-in user but no tenant. */
export const orgCreationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/orgs',
    { schema: { body: CreateOrgBody, response: { 201: Org } } },
    async (request, reply) => {
      const org = await createOrg(app.deps, currentUser(request).id, request.body);
      reply.code(201);
      return org;
    },
  );
};

/** Routes on the org itself, mounted under /orgs/:orgSlug. */
export const orgRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get('/', { schema: { params: OrgOnlyParams, response: { 200: Org } } }, async (request) =>
    getOrg(app.deps, request.tenant),
  );

  app.patch(
    '/',
    { schema: { params: OrgOnlyParams, body: UpdateOrgBody, response: { 200: Org } } },
    async (request) => renameOrg(app.deps, request.tenant, request.body),
  );

  app.delete(
    '/',
    { schema: { params: OrgOnlyParams, body: EmptyBody, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await removeOrg(app.deps, request.tenant);
      return reply.code(204).send();
    },
  );
};
