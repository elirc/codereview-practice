import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '../../src/db/db.js';
import { buildApp } from '../../src/http/app.js';
import { createLogger } from '../../src/lib/logger.js';
import { cryptoRandom } from '../../src/lib/random.js';
import type { ServiceContext } from '../../src/services/context.js';
import { FakeClock, resetDb, testConfig, TEST_DATABASE_URL } from './env.js';
import { RecordingNotifier } from './http.js';

export interface HttpTestApp {
  app: FastifyInstance;
  db: Db;
  clock: FakeClock;
  notifier: RecordingNotifier;
  ctx: ServiceContext;
  close(): Promise<void>;
}

/** Builds an HTTP-only app on a freshly emptied test database. */
export async function createHttpTestApp(): Promise<HttpTestApp> {
  const db = createDb(TEST_DATABASE_URL, 4);
  await resetDb(db);
  const clock = new FakeClock();
  const notifier = new RecordingNotifier();
  const ctx: ServiceContext = {
    db,
    clock,
    random: cryptoRandom,
    config: testConfig(),
    notifier,
  };
  const app = buildApp({ ctx, logger: createLogger('silent') });
  await app.ready();
  return {
    app,
    db,
    clock,
    notifier,
    ctx,
    async close() {
      await app.close();
      await db.destroy();
    },
  };
}
