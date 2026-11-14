import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './types.js';

export type Database = Kysely<DB>;

export function createDb(connectionString: string, maxConnections = 10): Database {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: maxConnections }),
    }),
  });
}

export interface PgError {
  code: string;
  constraint?: string;
}

function isPgError(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && typeof (err as PgError).code === 'string';
}

/** True for a unique-constraint violation, optionally on one named constraint or index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  return (
    isPgError(err) &&
    err.code === '23505' &&
    (constraint === undefined || err.constraint === constraint)
  );
}
