import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import type { AppContext } from '../../src/lib/server/context';
import { openDatabase, type Connection } from '../../src/lib/server/db/client';
import { runMigrations } from '../../src/lib/server/db/migrate';

export const TEST_ZONE = 'America/New_York';

export interface TestContext extends AppContext {
	path: string;
	connection: Connection;
	setNow(ms: number): void;
	advance(ms: number): void;
	close(): void;
}

/** A migrated temp-file database with a controllable clock. */
export function createTestContext(startAt: number, zone = TEST_ZONE): TestContext {
	const dir = mkdtempSync(join(tmpdir(), 'vs-test-'));
	const path = join(dir, 'test.sqlite');
	const connection = openDatabase(path);
	runMigrations(connection.db);
	let current = startAt;
	return {
		db: connection.db,
		zone,
		logger: pino({ level: 'silent' }),
		now: () => current,
		path,
		connection,
		setNow(ms) {
			current = ms;
		},
		advance(ms) {
			current += ms;
		},
		close() {
			connection.sqlite.close();
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

/** Opens a second connection to the same file, as another process would. */
export function reopen(ctx: TestContext): TestContext {
	const connection = openDatabase(ctx.path);
	return {
		...ctx,
		db: connection.db,
		connection,
		close() {
			connection.sqlite.close();
		}
	};
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
