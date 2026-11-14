import type { FastifyInstance } from 'fastify';
import { serializeRequest } from '../lib/logger.js';

/**
 * Logs one line when a request arrives and one when its response is sent.
 * Use with Fastify's `disableRequestLogging: true`.
 */
export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    request.log.info({ request: serializeRequest(request) }, 'incoming request');
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      { statusCode: reply.statusCode, responseTimeMs: Math.round(reply.elapsedTime) },
      'request completed',
    );
  });
}
