import { getConfig, type Config } from './config';
import type { AppContext } from './context';
import { openDatabase } from './db/client';
import { createLogger, type Logger } from './logger';

export interface App {
	config: Config;
	logger: Logger;
	ctx: AppContext;
}

let instance: App | undefined;

/** The web process's long-lived services, created on first use. */
export function getApp(): App {
	if (!instance) {
		const config = getConfig();
		const logger = createLogger(config.logLevel);
		const { db } = openDatabase(config.databasePath);
		instance = {
			config,
			logger,
			ctx: { db, zone: config.orgTimezone, now: () => Date.now(), logger }
		};
	}
	return instance;
}
