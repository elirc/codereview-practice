import { loadDatabaseConfig } from '../config/config.js';
import { createLogger } from '../lib/logger.js';
import { runMigrations } from './migrate.js';

const config = loadDatabaseConfig();
const logger = createLogger(config.LOG_LEVEL, { process: 'migrate' });

try {
  const applied = await runMigrations(config.DATABASE_URL, (message, file) =>
    logger.info({ file }, message),
  );
  logger.info({ count: applied.length }, 'migrations complete');
} catch (error) {
  logger.error({ err: error }, 'migration failed');
  process.exitCode = 1;
}
