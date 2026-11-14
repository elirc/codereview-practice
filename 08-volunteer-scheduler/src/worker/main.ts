import { setTimeout as sleep } from 'node:timers/promises';
import { getConfig } from '../lib/server/config';
import type { AppContext } from '../lib/server/context';
import { openDatabase } from '../lib/server/db/client';
import { jobHandlers } from '../lib/server/jobs/handlers';
import { runDueJobs } from '../lib/server/jobs/runner';
import { createLogger } from '../lib/server/logger';
import { dispatchOnce } from '../lib/server/outbox/dispatcher';
import { createProviders } from '../lib/server/outbox/providers';

const DISPATCH_INTERVAL_MS = 5_000;
const JOBS_INTERVAL_MS = 30_000;

const config = getConfig();
const logger = createLogger(config.logLevel).child({ process: 'worker' });
const { sqlite, db } = openDatabase(config.databasePath);
const ctx: AppContext = { db, zone: config.orgTimezone, now: () => Date.now(), logger };
const providers = createProviders(config, logger);
const shutdown = new AbortController();

async function loop(name: string, intervalMs: number, tick: () => Promise<unknown>) {
	while (!shutdown.signal.aborted) {
		try {
			await tick();
		} catch (err) {
			logger.error({ err, loop: name }, 'worker tick failed');
		}
		try {
			await sleep(intervalMs, undefined, { signal: shutdown.signal });
		} catch {
			// Aborted by shutdown; the while condition ends the loop.
		}
	}
	logger.info({ loop: name }, 'worker loop stopped');
}

function stop(signal: string) {
	if (shutdown.signal.aborted) return;
	logger.info({ signal }, 'shutting down after the current batch');
	shutdown.abort();
}

process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));

logger.info({ databasePath: config.databasePath, zone: config.orgTimezone }, 'worker started');
await Promise.all([
	loop('dispatcher', DISPATCH_INTERVAL_MS, () => dispatchOnce({ ctx, ...providers })),
	loop('jobs', JOBS_INTERVAL_MS, () => runDueJobs(ctx, jobHandlers))
]);
sqlite.close();
logger.info('worker stopped');
