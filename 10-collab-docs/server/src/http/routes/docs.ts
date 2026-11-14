import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WORKSPACE_ACCESS } from '../../domain/roles.js';
import type { ServiceContext } from '../../services/context.js';
import * as docs from '../../services/docs.js';
import { requireAuth } from '../auth.js';
import { principalOf, userPrincipalOf } from '../principal.js';
import { emptyBody, uuid, validate } from '../validate.js';

const workspaceParams = z.object({ id: uuid }).strict();
const docParams = z.object({ id: uuid }).strict();

const listQuery = z
  .object({ trashed: z.enum(['true', 'false']).default('false') })
  .strict();

const title = z.string().trim().min(1).max(200);
const workspaceAccess = z.enum(WORKSPACE_ACCESS);

const createBody = z
  .object({ title, workspaceAccess: workspaceAccess.optional() })
  .strict();

const updateBody = z
  .object({ title: title.optional(), workspaceAccess: workspaceAccess.optional() })
  .strict();

const transferBody = z.object({ userId: uuid }).strict();

export function docRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  app.get('/workspaces/:id/docs', async (request) => {
    const session = requireAuth(request);
    const { id } = validate(workspaceParams, request.params);
    const { trashed } = validate(listQuery, request.query ?? {});
    return {
      docs: await docs.listDocs(ctx, session.user.id, id, { trashed: trashed === 'true' }),
    };
  });

  app.post('/workspaces/:id/docs', async (request, reply) => {
    const session = requireAuth(request);
    const { id } = validate(workspaceParams, request.params);
    const input = validate(createBody, request.body);
    const doc = await docs.createDoc(ctx, session.user.id, id, input);
    return reply.status(201).send({ doc });
  });

  app.get('/docs/:id', async (request) => {
    const { id } = validate(docParams, request.params);
    return { doc: await docs.getDoc(ctx, id, principalOf(request)) };
  });

  app.patch('/docs/:id', async (request) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(docParams, request.params);
    const input = validate(updateBody, request.body);
    return { doc: await docs.updateDoc(ctx, id, principal, input) };
  });

  app.post('/docs/:id/transfer', async (request) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(docParams, request.params);
    const input = validate(transferBody, request.body);
    return { doc: await docs.transferDoc(ctx, id, principal, input) };
  });

  app.post('/docs/:id/trash', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(docParams, request.params);
    validate(emptyBody, request.body);
    await docs.trashDoc(ctx, id, principal);
    return reply.status(204).send();
  });

  app.post('/docs/:id/restore', async (request) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(docParams, request.params);
    validate(emptyBody, request.body);
    return { doc: await docs.restoreDoc(ctx, id, principal) };
  });
}
