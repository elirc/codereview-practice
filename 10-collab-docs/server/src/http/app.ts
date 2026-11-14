import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/config.js';
import type { Logger } from '../lib/logger.js';
import { registerErrorHandling } from './errors.js';

export interface AppOptions {
  config: Config;
  logger: Logger;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Builds the HTTP application without starting to listen. */
export function buildApp(options: AppOptions): FastifyInstance {
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

  app.get('/api/health', async () => ({ status: 'ok' }));

  return app;
}
