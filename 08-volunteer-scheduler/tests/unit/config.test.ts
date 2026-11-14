import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/server/config';

describe('loadConfig', () => {
	it('applies defaults for an empty environment', () => {
		const config = loadConfig({});
		expect(config.orgTimezone).toBe('America/New_York');
		expect(config.databasePath).toBe('data/volunteer-scheduler.sqlite');
		expect(config.sessionTtlDays).toBe(14);
		expect(config.nodeEnv).toBe('development');
	});

	it('reads explicit values', () => {
		const config = loadConfig({
			ORG_TIMEZONE: 'Europe/London',
			DATABASE_PATH: '/tmp/vs.sqlite',
			SESSION_TTL_DAYS: '3',
			NODE_ENV: 'production'
		});
		expect(config.orgTimezone).toBe('Europe/London');
		expect(config.databasePath).toBe('/tmp/vs.sqlite');
		expect(config.sessionTtlDays).toBe(3);
		expect(config.nodeEnv).toBe('production');
	});

	it('rejects an unknown time zone', () => {
		expect(() => loadConfig({ ORG_TIMEZONE: 'Mars/Olympus' })).toThrow(/ORG_TIMEZONE/);
	});

	it('rejects an out-of-range session lifetime and lists every problem', () => {
		expect(() => loadConfig({ SESSION_TTL_DAYS: '0', LOG_LEVEL: 'loud' })).toThrow(
			/SESSION_TTL_DAYS.*LOG_LEVEL|LOG_LEVEL.*SESSION_TTL_DAYS/
		);
	});
});
