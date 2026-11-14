import type { DB } from './db/client';
import type { Logger } from './logger';

/** What domain services need from their environment; tests supply a fixed clock. */
export interface AppContext {
	db: DB;
	/** IANA zone for civil dates and wall times. */
	zone: string;
	now: () => number;
	logger: Logger;
}
