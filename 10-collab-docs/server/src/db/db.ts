import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './types.js';

const INT8_OID = 20;

// int8 columns (sequence numbers, byte counts, epochs, counts) stay far below 2^53.
pg.types.setTypeParser(INT8_OID, (value: string) => Number(value));

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;

/** Opens a pooled Kysely connection to Postgres. */
export function createDb(databaseUrl: string, maxConnections = 10): Db {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: databaseUrl, max: maxConnections }),
    }),
  });
}

/** Runs `fn` inside a read-only REPEATABLE READ transaction and returns its result. */
export function readSnapshot<T>(db: Db, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      await sql`set transaction read only`.execute(trx);
      return fn(trx);
    });
}

/** Views a byte array as a Buffer suitable for a bytea parameter. */
export function toBytea(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Returns whether a database error is a unique violation, optionally of one constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pgError = error as { code?: unknown; constraint?: unknown };
  return pgError.code === '23505' && (constraint === undefined || pgError.constraint === constraint);
}
