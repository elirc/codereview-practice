import { ConfigError, loadConfig, type Config } from './config/config.js';
import { createInstance } from './instance.js';
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
const instance = createInstance({ config, logger });

await instance.listen();
logger.info({ port: config.PORT }, 'server listening');

process.once('SIGTERM', () => {
  logger.info('shutting down');
  instance.close().then(
    () => process.exit(0),
    (error: unknown) => {
      logger.error({ err: error }, 'shutdown failed');
      process.exit(1);
    },
  );
});
