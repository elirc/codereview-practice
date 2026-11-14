import { ConfigError, loadConfig, type Config } from '../config/config.js';
import { createDb } from '../db/db.js';
import { systemClock } from '../lib/clock.js';
import { createLogger } from '../lib/logger.js';
import { autoVersionOnce } from './autoVersions.js';
import { compactOnce } from './compaction.js';
import { startLoop, type LoopHandle } from './loop.js';
import { purgeSessionsOnce } from './sessionPurge.js';
import { purgeTrashOnce } from './trashPurge.js';

const SECOND = 1_000;
const HOUR = 3_600 * SECOND;

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
const logger = createLogger(config.LOG_LEVEL, { process: 'worker' });
const db = createDb(config.DATABASE_URL, 4);
const clock = systemClock;

const loops: LoopHandle[] = [
  startLoop({
    name: 'compaction',
    intervalMs: 30 * SECOND,
    clock,
    logger,
    run: (now) =>
      compactOnce(
        { db, logger, minUpdates: config.COMPACT_MIN_UPDATES, minBytes: config.COMPACT_MIN_BYTES },
        now,
      ),
  }),
  startLoop({
    name: 'automatic versions',
    intervalMs: 60 * SECOND,
    clock,
    logger,
    run: (now) => autoVersionOnce({ db, logger, minutes: config.AUTO_VERSION_MINUTES }, now),
  }),
  startLoop({
    name: 'trash purge',
    intervalMs: HOUR,
    clock,
    logger,
    run: (now) => purgeTrashOnce({ db, logger, retentionDays: config.TRASH_RETENTION_DAYS }, now),
  }),
  startLoop({
    name: 'session purge',
    intervalMs: HOUR,
    clock,
    logger,
    run: (now) => purgeSessionsOnce(db, now),
  }),
];

logger.info('worker started');

process.once('SIGTERM', () => {
  logger.info('worker stopping');
  Promise.all(loops.map((loop) => loop.stop()))
    .then(() => db.destroy())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'worker shutdown failed');
        process.exit(1);
      },
    );
});
