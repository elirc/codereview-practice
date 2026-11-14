import { ConfigError, loadConfig, type Config } from './config/config.js';
import { createDb } from './db/db.js';
import { buildApp } from './http/app.js';
import { systemClock } from './lib/clock.js';
import { createLogger } from './lib/logger.js';
import { cryptoRandom } from './lib/random.js';
import { silentNotifier } from './services/notifier.js';

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
const logger = createLogger(config.LOG_LEVEL, { process: 'server' });
const db = createDb(config.DATABASE_URL);
const ctx = { db, clock: systemClock, random: cryptoRandom, config, notifier: silentNotifier };
const app = buildApp({ ctx, logger });

await app.listen({ port: config.PORT, host: config.HOST });

process.once('SIGTERM', () => {
  logger.info('shutting down');
  app
    .close()
    .then(() => db.destroy())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
});
