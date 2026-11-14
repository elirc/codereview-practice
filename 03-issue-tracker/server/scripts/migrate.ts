import path from 'node:path';
import { loadConfig, loadDotEnvIfPresent } from '../src/config.js';
import { runMigrations } from '../src/db/migrator.js';
import { createScriptLogger } from '../src/lib/logger.js';

loadDotEnvIfPresent();
const config = loadConfig(process.env);
const log = createScriptLogger('migrate', config.logLevel);

try {
  const applied = await runMigrations(config.databaseUrl, path.resolve('migrations'), (file) =>
    log.info({ file }, 'migration applied'),
  );
  log.info({ count: applied.length }, applied.length ? 'migrations complete' : 'schema up to date');
} catch (err) {
  log.error({ err }, 'migration failed');
  process.exitCode = 1;
}
