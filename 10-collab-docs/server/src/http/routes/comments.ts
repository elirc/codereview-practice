import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fromBase64 } from '../../lib/bytes.js';
import * as comments from '../../services/comments.js';
import type { ServiceContext } from '../../services/context.js';
import { principalOf, userPrincipalOf } from '../principal.js';
import { emptyBody, uuid, validate } from '../validate.js';

const idParams = z.object({ id: uuid }).strict();

const body = z.string().min(1).max(4000);

const encodedPosition = z
  .string()
  .min(1)
  .max(1000)
  .transform((value, issue) => {
    try {
      return fromBase64(value);
    } catch {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be base64' });
      return z.NEVER;
    }
  });

const threadBody = z
  .object({
    anchor: z.object({ start: encodedPosition, end: encodedPosition }).strict(),
    body,
  })
  .strict();

const commentBody = z.object({ body }).strict();

export function commentRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  app.get('/docs/:id/threads', async (request) => {
    const { id } = validate(idParams, request.params);
    return { threads: await comments.listThreads(ctx, id, principalOf(request)) };
  });

  app.post('/docs/:id/threads', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(idParams, request.params);
    const input = validate(threadBody, request.body);
    const thread = await comments.createThread(ctx, id, principal, input);
    return reply.status(201).send({ thread });
  });

  app.post('/threads/:id/comments', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(idParams, request.params);
    const input = validate(commentBody, request.body);
    const comment = await comments.reply(ctx, id, principal, input);
    return reply.status(201).send({ comment });
  });

  app.patch('/comments/:id', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(idParams, request.params);
    const input = validate(commentBody, request.body);
    await comments.editComment(ctx, id, principal, input);
    return reply.status(204).send();
  });

  app.delete('/comments/:id', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(idParams, request.params);
    await comments.deleteComment(ctx, id, principal);
    return reply.status(204).send();
  });

  app.post('/threads/:id/resolve', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(idParams, request.params);
    validate(emptyBody, request.body);
    await comments.setThreadStatus(ctx, id, principal, 'resolved');
    return reply.status(204).send();
  });

  app.post('/threads/:id/reopen', async (request, reply) => {
    const principal = userPrincipalOf(request);
    const { id } = validate(idParams, request.params);
    validate(emptyBody, request.body);
    await comments.setThreadStatus(ctx, id, principal, 'open');
    return reply.status(204).send();
  });
}
