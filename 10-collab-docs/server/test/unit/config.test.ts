import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/config.js';

const base = {
  DATABASE_URL: 'postgres://collab:collab@localhost:5462/collab',
  REDIS_URL: 'redis://localhost:6391',
  APP_ORIGIN: 'http://localhost:5180',
};

describe('loadConfig', () => {
  it('applies defaults for optional settings', () => {
    const config = loadConfig(base);
    expect(config.PORT).toBe(8100);
    expect(config.MAX_UPDATE_BYTES).toBe(262_144);
    expect(config.MAX_DOC_BYTES).toBe(5_242_880);
    expect(config.WS_RATE_PER_SEC).toBe(50);
    expect(config.WS_RATE_BURST).toBe(100);
    expect(config.LOOPS_ENABLED).toBe(true);
    expect(config.INSTANCE_ID).toBeUndefined();
  });

  it('coerces numeric and boolean values', () => {
    const config = loadConfig({ ...base, PORT: '8101', LOOPS_ENABLED: 'false' });
    expect(config.PORT).toBe(8101);
    expect(config.LOOPS_ENABLED).toBe(false);
  });

  it('fails fast when a required value is missing', () => {
    expect(() => loadConfig({ ...base, REDIS_URL: undefined })).toThrow(ConfigError);
  });

  it('rejects an origin with a path', () => {
    expect(() => loadConfig({ ...base, APP_ORIGIN: 'http://localhost:5180/app' })).toThrow(
      /APP_ORIGIN/,
    );
  });
});
