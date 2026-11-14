import { ConfigError, loadConfig, type Config } from './config/config.js';
import { buildApp } from './http/app.js';
import { createLogger } from './lib/logger.js';

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
const app = buildApp({ config, logger });

await app.listen({ port: config.PORT, host: config.HOST });

process.once('SIGTERM', () => {
  logger.info('shutting down');
  app.close().then(
    () => process.exit(0),
    (error: unknown) => {
      logger.error({ err: error }, 'shutdown failed');
      process.exit(1);
    },
  );
});
