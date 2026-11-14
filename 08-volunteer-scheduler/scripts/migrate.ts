import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfig } from '../src/lib/server/config';
import { openDatabase } from '../src/lib/server/db/client';
import { runMigrations } from '../src/lib/server/db/migrate';
import { createLogger } from '../src/lib/server/logger';

const config = getConfig();
const logger = createLogger(config.logLevel);

mkdirSync(dirname(config.databasePath), { recursive: true });
const { sqlite, db } = openDatabase(config.databasePath);
try {
	runMigrations(db);
	logger.info({ databasePath: config.databasePath }, 'migrations applied');
} catch (err) {
	logger.error({ err }, 'migration failed');
	process.exitCode = 1;
} finally {
	sqlite.close();
}
