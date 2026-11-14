import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServiceContext } from '../../services/context.js';
import * as versions from '../../services/versions.js';
import { userPrincipalOf } from '../principal.js';
import { emptyBody, uuid, validate } from '../validate.js';

const idParams = z.object({ id: uuid }).strict();
const restoreParams = z.object({ id: uuid, versionId: uuid }).strict();
const namedBody = z.object({ label: z.string().trim().min(1).max(100) }).strict();

export function versionRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  app.get('/docs/:id/versions', async (request) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(idParams, request.params);
    return { versions: await versions.listVersions(ctx, id, principal) };
  });

  app.post('/docs/:id/versions', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(idParams, request.params);
    const input = validate(namedBody, request.body);
    const version = await versions.createNamedVersion(ctx, id, principal, input);
    return reply.status(201).send({ version });
  });

  app.get('/versions/:id', async (request) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(idParams, request.params);
    return { version: await versions.getVersion(ctx, id, principal) };
  });

  app.post('/docs/:id/versions/:versionId/restore', async (request) => {
    const principal = userPrincipalOf(request);
    const { id, versionId } = validate(restoreParams, request.params);
    validate(emptyBody, request.body);
    return versions.restoreVersion(ctx, id, versionId, principal);
  });
}
