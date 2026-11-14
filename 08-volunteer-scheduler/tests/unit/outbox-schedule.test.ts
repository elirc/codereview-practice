import { describe, expect, it } from 'vitest';
import { wallTimeToInstant } from '../../src/lib/domain/time';
import {
	backoffMs,
	isQuietHours,
	MAX_ATTEMPTS,
	quietHoursEnd
} from '../../src/lib/server/outbox/schedule';

const NY = 'America/New_York';
const MINUTE = 60_000;

describe('backoffMs', () => {
	it('waits 1, 5, 25 and 120 minutes after attempts one to four', () => {
		expect([1, 2, 3, 4].map(backoffMs)).toEqual([1, 5, 25, 120].map((m) => m * MINUTE));
	});

	it('gives up after five attempts', () => {
		expect(MAX_ATTEMPTS).toBe(5);
	});
});

describe('quiet hours', () => {
	const at = (date: string, time: string) => wallTimeToInstant(date, time, NY);

	it('covers 21:00 up to but not including 08:00 local time', () => {
		expect(isQuietHours(at('2026-01-15', '20:59'), NY)).toBe(false);
		expect(isQuietHours(at('2026-01-15', '21:00'), NY)).toBe(true);
		expect(isQuietHours(at('2026-01-16', '03:00'), NY)).toBe(true);
		expect(isQuietHours(at('2026-01-16', '07:59'), NY)).toBe(true);
		expect(isQuietHours(at('2026-01-16', '08:00'), NY)).toBe(false);
	});

	it('ends at the next local 08:00', () => {
		expect(quietHoursEnd(at('2026-01-15', '22:00'), NY)).toBe(at('2026-01-16', '08:00'));
		expect(quietHoursEnd(at('2026-01-16', '06:30'), NY)).toBe(at('2026-01-16', '08:00'));
	});

	it('ends at 08:00 local time across a daylight-saving change', () => {
		expect(quietHoursEnd(at('2026-03-07', '22:00'), NY)).toBe(Date.UTC(2026, 2, 8, 12, 0));
		expect(quietHoursEnd(at('2026-10-31', '22:00'), NY)).toBe(Date.UTC(2026, 10, 1, 13, 0));
	});
});
