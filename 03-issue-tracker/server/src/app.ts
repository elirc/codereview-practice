import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import type { Config } from './config.js';
import type { Clock } from './lib/clock.js';
import { healthRoutes } from './modules/health/routes.js';
import { registerCsrfProtection } from './plugins/csrf.js';
import { registerErrorHandling } from './plugins/error-handler.js';

export interface AppDeps {
  config: Config;
  clock: Clock;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export async function buildApp(deps: AppDeps) {
  const base = Fastify({
    logger: {
      level: deps.config.logLevel,
      redact: ['req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    genReqId: () => randomUUID(),
    bodyLimit: 256 * 1024,
    ajv: {
      // Reject unknown properties instead of silently dropping them.
      customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true },
    },
  });

  base.decorate('deps', deps);
  await base.register(cookie);
  base.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  registerCsrfProtection(base, deps.config.appOrigin);
  registerErrorHandling(base);

  const app = base.withTypeProvider<TypeBoxTypeProvider>();
  await app.register(
    async (api) => {
      await api.register(healthRoutes);
    },
    { prefix: '/api' },
  );
  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
