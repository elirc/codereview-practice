import { randomUUID } from 'node:crypto';
import { loadConfig, loadDotEnvIfPresent } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { systemClock } from '../src/lib/clock.js';
import { createScriptLogger } from '../src/lib/logger.js';
import { deleteExpiredSessions } from '../src/modules/auth/repo.js';

// Intended to run from cron, e.g. hourly: `npm run purge-sessions`.
loadDotEnvIfPresent();
const config = loadConfig(process.env);
const log = createScriptLogger('purge-sessions', config.logLevel);
const db = createDb(config.databaseUrl, 1);
const job = { jobId: randomUUID(), attempt: 1 };

log.info(job, 'purge-sessions started');
try {
  const deleted = await deleteExpiredSessions(systemClock.now(), db);
  log.info({ ...job, deleted }, 'purge-sessions finished');
} catch (err) {
  log.error({ ...job, err }, 'purge-sessions failed');
  process.exitCode = 1;
} finally {
  await db.destroy();
}
