import { runMigrations } from '../../src/db/migrate.js';
import { TEST_DATABASE_URL } from '../helpers/env.js';

export default async function setup(): Promise<void> {
  await runMigrations(TEST_DATABASE_URL, () => undefined);
}
