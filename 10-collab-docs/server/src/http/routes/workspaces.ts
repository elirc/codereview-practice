import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServiceContext } from '../../services/context.js';
import * as workspaces from '../../services/workspaces.js';
import { requireAuth } from '../auth.js';
import { uuid, validate } from '../validate.js';

const workspaceParams = z.object({ id: uuid }).strict();
const memberParams = z.object({ id: uuid, userId: uuid }).strict();

const name = z.string().trim().min(1).max(100);

const createBody = z.object({ name }).strict();

const updateBody = z
  .object({
    name: name.optional(),
    allowExternalSharing: z.boolean().optional(),
  })
  .strict();

const memberRole = z.enum(['admin', 'member']);

const addMemberBody = z
  .object({
    email: z.string().trim().email().max(254),
    role: memberRole.default('member'),
  })
  .strict();

const updateMemberBody = z.object({ role: memberRole }).strict();

const transferBody = z.object({ userId: uuid }).strict();

export function workspaceRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  app.get('/workspaces', async (request) => {
    const session = requireAuth(request);
    return { workspaces: await workspaces.listWorkspaces(ctx, session.user.id) };
  });

  app.post('/workspaces', async (request, reply) => {
    const session = requireAuth(request);
    const input = validate(createBody, request.body);
    const workspace = await workspaces.createWorkspace(ctx, session.user.id, input);
    return reply.status(201).send({ workspace });
  });

  app.patch('/workspaces/:id', async (request) => {
    const session = requireAuth(request);
    const { id } = validate(workspaceParams, request.params);
    const input = validate(updateBody, request.body);
    return { workspace: await workspaces.updateWorkspace(ctx, session.user.id, id, input) };
  });

  app.get('/workspaces/:id/members', async (request) => {
    const session = requireAuth(request);
    const { id } = validate(workspaceParams, request.params);
    return { members: await workspaces.listMembers(ctx, session.user.id, id) };
  });

  app.post('/workspaces/:id/members', async (request, reply) => {
    const session = requireAuth(request);
    const { id } = validate(workspaceParams, request.params);
    const input = validate(addMemberBody, request.body);
    const member = await workspaces.addMember(ctx, session.user.id, id, input);
    return reply.status(201).send({ member });
  });

  app.patch('/workspaces/:id/members/:userId', async (request, reply) => {
    const session = requireAuth(request);
    const { id, userId } = validate(memberParams, request.params);
    const input = validate(updateMemberBody, request.body);
    await workspaces.updateMember(ctx, session.user.id, id, userId, input);
    return reply.status(204).send();
  });

  app.delete('/workspaces/:id/members/:userId', async (request, reply) => {
    const session = requireAuth(request);
    const { id, userId } = validate(memberParams, request.params);
    await workspaces.removeMember(ctx, session.user.id, id, userId);
    return reply.status(204).send();
  });

  app.post('/workspaces/:id/transfer', async (request, reply) => {
    const session = requireAuth(request);
    const { id } = validate(workspaceParams, request.params);
    const input = validate(transferBody, request.body);
    await workspaces.transferWorkspace(ctx, session.user.id, id, input);
    return reply.status(204).send();
  });
}
