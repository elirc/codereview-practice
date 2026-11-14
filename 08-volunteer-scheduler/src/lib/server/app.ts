import { getConfig, type Config } from './config';
import { createLogger, type Logger } from './logger';

export interface App {
	config: Config;
	logger: Logger;
}

let instance: App | undefined;

/** The web process's long-lived services, created on first use. */
export function getApp(): App {
	if (!instance) {
		const config = getConfig();
		const logger = createLogger(config.logLevel);
		instance = { config, logger };
	}
	return instance;
}
