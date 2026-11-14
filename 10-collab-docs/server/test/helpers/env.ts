import { sql } from 'kysely';
import { loadConfig, type Config } from '../../src/config/config.js';
import type { Db } from '../../src/db/db.js';
import type { Clock } from '../../src/lib/clock.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://collab:collab@localhost:5462/collab_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6391';
export const TEST_ORIGIN = 'http://localhost:5180';

/** Builds a validated configuration for tests with background loops switched off. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    APP_ORIGIN: TEST_ORIGIN,
    LOOPS_ENABLED: 'false',
    ...overrides,
  });
}

/** A clock that only moves when the test moves it. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start = '2026-03-02T09:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(iso: string): void {
    this.current = new Date(iso).getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** Removes every row from every application table. */
export async function resetDb(db: Db): Promise<void> {
  await sql`
    truncate table comments, comment_threads, doc_versions, doc_snapshots, doc_updates,
      doc_links, doc_shares, docs, workspace_members, workspaces, sessions, users
    restart identity cascade
  `.execute(db);
}
