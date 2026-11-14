import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 10_200_017;

/**
 * Applies every migration file in `dir` that is not yet recorded in
 * `schema_migrations`, each in its own transaction, in file-name order.
 * Returns the names of the files applied by this call.
 */
export async function runMigrations(
  databaseUrl: string,
  log: (message: string, file?: string) => void,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const done = await client.query<{ name: string }>('select name from schema_migrations');
    const applied = new Set(done.rows.map((row) => row.name));
    const files = (await readdir(dir)).filter((file) => MIGRATION_FILE.test(file)).sort();

    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const text = await readFile(join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(text);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
      log('migration applied', file);
      ran.push(file);
    }
    return ran;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
