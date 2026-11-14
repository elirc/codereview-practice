import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
// Arbitrary constant shared by every runner so concurrent deploys apply migrations one at a time.
const ADVISORY_LOCK_KEY = 703_003;

/**
 * Applies every `NNNN_name.sql` file in `directory` that is not yet recorded in
 * `schema_migrations`, each in its own transaction, in file-name order.
 * Returns the names of the files applied by this run.
 */
export async function runMigrations(
  connectionString: string,
  directory: string,
  onApplied: (file: string) => void = () => {},
): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations',
    );
    const applied = new Set(rows.map((row) => row.filename));
    const files = (await readdir(directory)).filter((file) => MIGRATION_FILE.test(file)).sort();

    const appliedNow: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const statements = await readFile(path.join(directory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(statements);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      appliedNow.push(file);
      onApplied(file);
    }
    return appliedNow;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
