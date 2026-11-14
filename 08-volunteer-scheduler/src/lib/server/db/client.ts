import Database from 'better-sqlite3';
import type { RunResult } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema>;

/** Either the database or an open transaction; both expose the same query builder. */
export type Tx = BaseSQLiteDatabase<'sync', RunResult, typeof schema>;

export interface Connection {
	sqlite: Database.Database;
	db: DB;
}

export const IMMEDIATE = { behavior: 'immediate' } as const;

export function openDatabase(path: string): Connection {
	const sqlite = new Database(path);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('busy_timeout = 5000');
	sqlite.pragma('synchronous = NORMAL');
	return { sqlite, db: drizzle(sqlite, { schema }) };
}

/** better-sqlite3 error code, looking through wrapper errors. */
export function sqliteErrorCode(err: unknown): string | undefined {
	let current: unknown = err;
	for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === 'string' && code.startsWith('SQLITE_')) return code;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

export function isBusyError(err: unknown): boolean {
	const code = sqliteErrorCode(err);
	return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED';
}

export function isUniqueViolation(err: unknown): boolean {
	const code = sqliteErrorCode(err);
	return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}
