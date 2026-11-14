import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { EmptyBody } from '../../lib/schemas.js';
import type { TenantContext } from '../../plugins/tenant.js';
import {
  AddMemberBody,
  ListMembersQuery,
  Member,
  MemberPage,
  MemberParams,
  MembersParams,
  UpdateMemberBody,
} from './schemas.js';
import { addMember, changeMemberRole, listMembers, removeMember } from './service.js';

function resolveUserId(tenant: TenantContext, userId: string): string {
  return userId === 'me' ? tenant.userId : userId;
}

export const memberRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/members',
    {
      schema: {
        params: MembersParams,
        querystring: ListMembersQuery,
        response: { 200: MemberPage },
      },
    },
    async (request) => listMembers(app.deps, request.tenant, request.query),
  );

  app.post(
    '/members',
    { schema: { params: MembersParams, body: AddMemberBody, response: { 201: Member } } },
    async (request, reply) => {
      const member = await addMember(app.deps, request.tenant, request.body);
      reply.code(201);
      return member;
    },
  );

  app.patch(
    '/members/:userId',
    { schema: { params: MemberParams, body: UpdateMemberBody, response: { 200: Member } } },
    async (request) =>
      changeMemberRole(
        app.deps,
        request.tenant,
        resolveUserId(request.tenant, request.params.userId),
        request.body.role,
      ),
  );

  app.delete(
    '/members/:userId',
    { schema: { params: MemberParams, body: EmptyBody, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await removeMember(
        app.deps,
        request.tenant,
        resolveUserId(request.tenant, request.params.userId),
      );
      return reply.code(204).send();
    },
  );
};
