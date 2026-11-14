import path from 'node:path';
import { runMigrations } from '../src/db/migrator.js';
import { testDatabaseUrl } from './support/config.js';

export default async function setup(): Promise<void> {
  await runMigrations(testDatabaseUrl(), path.resolve('migrations'));
}
