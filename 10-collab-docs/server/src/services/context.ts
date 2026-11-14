import type { Config } from '../config/config.js';
import type { Db } from '../db/db.js';
import type { Clock } from '../lib/clock.js';
import type { RandomSource } from '../lib/random.js';
import type { LiveDocs } from './liveDocs.js';
import type { Notifier } from './notifier.js';

/** Dependencies shared by the service functions. */
export interface ServiceContext {
  db: Db;
  clock: Clock;
  random: RandomSource;
  config: Config;
  notifier: Notifier;
  live: LiveDocs;
}
