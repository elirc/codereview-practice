import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from '../lib/logger.js';
import type { ServiceContext } from '../services/context.js';
import { registerAuth } from './auth.js';
import { registerErrorHandling } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { commentRoutes } from './routes/comments.js';
import { docRoutes } from './routes/docs.js';
import { sharingRoutes } from './routes/sharing.js';
import { versionRoutes } from './routes/versions.js';
import { workspaceRoutes } from './routes/workspaces.js';

export interface AppOptions {
  ctx: ServiceContext;
  logger: Logger;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Builds the HTTP application without starting to listen. */
export function buildApp(options: AppOptions): FastifyInstance {
  const { ctx } = options;
  const app = Fastify({
    loggerInstance: options.logger,
    requestIdLogLabel: 'requestId',
    genReqId: (req) => {
      const inbound = req.headers['x-request-id'];
      return typeof inbound === 'string' && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    },
    bodyLimit: 1_048_576,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerErrorHandling(app);
  void app.register(cookie);

  void app.register(
    async (api) => {
      registerAuth(api, ctx);
      api.get('/health', async () => ({ status: 'ok' }));
      authRoutes(api, ctx);
      workspaceRoutes(api, ctx);
      docRoutes(api, ctx);
      sharingRoutes(api, ctx);
      commentRoutes(api, ctx);
      versionRoutes(api, ctx);
    },
    { prefix: '/api' },
  );

  return app;
}
