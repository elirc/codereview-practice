import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { DB } from './client';

export function runMigrations(db: DB, migrationsFolder = resolve(process.cwd(), 'drizzle')): void {
	migrate(db, { migrationsFolder });
}
