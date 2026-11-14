import { loadConfig, type Config } from '../../src/config.js';

export const APP_ORIGIN = 'http://localhost:5303';

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? 'postgres://issues:issues@localhost:5453/issues_test';
}

export function testConfig(): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    APP_ORIGIN,
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
  });
}
