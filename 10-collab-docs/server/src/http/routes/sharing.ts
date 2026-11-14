import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SHARE_ROLES } from '../../domain/roles.js';
import type { ServiceContext } from '../../services/context.js';
import * as sharing from '../../services/sharing.js';
import { userPrincipalOf } from '../principal.js';
import { uuid, validate } from '../validate.js';

const docParams = z.object({ id: uuid }).strict();
const shareParams = z.object({ id: uuid, userId: uuid }).strict();
const linkParams = z.object({ id: uuid, linkId: uuid }).strict();

const role = z.enum(SHARE_ROLES);

const shareBody = z
  .object({ email: z.string().trim().email().max(254), role })
  .strict();

const updateShareBody = z.object({ role }).strict();

const linkBody = z
  .object({
    role,
    expiresAt: z
      .string()
      .datetime()
      .transform((value) => new Date(value))
      .nullable()
      .default(null),
  })
  .strict();

export function sharingRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  app.get('/docs/:id/shares', async (request) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(docParams, request.params);
    return { shares: await sharing.listShares(ctx, id, principal) };
  });

  app.post('/docs/:id/shares', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(docParams, request.params);
    const input = validate(shareBody, request.body);
    const share = await sharing.shareDoc(ctx, id, principal, input);
    return reply.status(201).send({ share });
  });

  app.patch('/docs/:id/shares/:userId', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id, userId } = validate(shareParams, request.params);
    const input = validate(updateShareBody, request.body);
    await sharing.updateShare(ctx, id, principal, userId, input);
    return reply.status(204).send();
  });

  app.delete('/docs/:id/shares/:userId', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id, userId } = validate(shareParams, request.params);
    await sharing.deleteShare(ctx, id, principal, userId);
    return reply.status(204).send();
  });

  app.get('/docs/:id/links', async (request) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(docParams, request.params);
    return { links: await sharing.listLinks(ctx, id, principal) };
  });

  app.post('/docs/:id/links', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(docParams, request.params);
    const input = validate(linkBody, request.body);
    const created = await sharing.createLink(ctx, id, principal, input);
    return reply.status(201).send(created);
  });

  app.delete('/docs/:id/links/:linkId', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id, linkId } = validate(linkParams, request.params);
    await sharing.revokeLink(ctx, id, principal, linkId);
    return reply.status(204).send();
  });
}
