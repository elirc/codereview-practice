import { describe, expect, it } from 'vitest';
import {
	addDays,
	daysBetween,
	isCivilDate,
	minutesOfDay,
	weekdayIndex
} from '../../src/lib/domain/dates';
import {
	isoWithOffset,
	nextWallTime,
	orgDate,
	orgWallTime,
	startOfOrgDay,
	wallTimeToInstant
} from '../../src/lib/domain/time';

const NY = 'America/New_York';
const MINUTE = 60_000;

describe('civil dates', () => {
	it('validates calendar dates', () => {
		expect(isCivilDate('2028-02-29')).toBe(true);
		expect(isCivilDate('2026-02-29')).toBe(false);
		expect(isCivilDate('2026-13-01')).toBe(false);
		expect(isCivilDate('2026-1-01')).toBe(false);
	});

	it('does date arithmetic across month and year ends', () => {
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(daysBetween('2026-01-01', '2026-03-01')).toBe(59);
	});

	it('reads wall times as minutes after midnight', () => {
		expect(minutesOfDay('00:00')).toBe(0);
		expect(minutesOfDay('09:30')).toBe(570);
		expect(minutesOfDay('23:59')).toBe(1439);
	});

	it('numbers weekdays from Monday', () => {
		expect(weekdayIndex('2026-01-05')).toBe(0);
		expect(weekdayIndex('2026-01-07')).toBe(2);
		expect(weekdayIndex('2026-01-11')).toBe(6);
		expect(weekdayIndex('1969-12-29')).toBe(0);
	});
});

describe('wallTimeToInstant', () => {
	it('converts an ordinary local time', () => {
		expect(wallTimeToInstant('2026-01-15', '09:00', NY)).toBe(Date.UTC(2026, 0, 15, 14, 0));
		expect(wallTimeToInstant('2026-07-15', '09:00', NY)).toBe(Date.UTC(2026, 6, 15, 13, 0));
	});

	it('moves a time inside the spring-forward gap later by the gap', () => {
		const instant = wallTimeToInstant('2026-03-08', '02:30', NY);
		expect(instant).toBe(Date.UTC(2026, 2, 8, 7, 30));
		expect(orgWallTime(instant, NY)).toBe('03:30');
	});

	it('picks the earlier instant for a repeated fall-back time', () => {
		const instant = wallTimeToInstant('2026-11-01', '01:30', NY);
		expect(instant).toBe(Date.UTC(2026, 10, 1, 5, 30));
		expect(isoWithOffset(instant, NY)).toBe('2026-11-01T01:30:00-04:00');
	});

	it('leaves other times on transition days alone', () => {
		expect(wallTimeToInstant('2026-03-08', '10:00', NY)).toBe(Date.UTC(2026, 2, 8, 14, 0));
		expect(wallTimeToInstant('2026-11-01', '10:00', NY)).toBe(Date.UTC(2026, 10, 1, 15, 0));
	});

	it('handles other zones', () => {
		expect(wallTimeToInstant('2026-03-29', '01:30', 'Europe/London')).toBe(
			Date.UTC(2026, 2, 29, 1, 30)
		);
		expect(wallTimeToInstant('2026-06-01', '12:00', 'UTC')).toBe(Date.UTC(2026, 5, 1, 12, 0));
	});

	it('gives a daily 02:30 slot its shifted start only on the gap day', () => {
		const times = ['2026-03-07', '2026-03-08', '2026-03-09'].map((date) =>
			orgWallTime(wallTimeToInstant(date, '02:30', NY), NY)
		);
		expect(times).toEqual(['02:30', '03:30', '02:30']);
	});
});

describe('durations and local dates', () => {
	it('measures durations in elapsed time across fall-back', () => {
		const start = wallTimeToInstant('2026-11-01', '01:00', NY);
		const end = start + 120 * MINUTE;
		expect(orgWallTime(end, NY)).toBe('02:00');
	});

	it('lists a late shift under its local start date', () => {
		const start = wallTimeToInstant('2026-01-15', '23:30', NY);
		const end = start + 90 * MINUTE;
		expect(orgDate(start, NY)).toBe('2026-01-15');
		expect(orgDate(end, NY)).toBe('2026-01-16');
		expect(orgWallTime(end, NY)).toBe('01:00');
	});

	it('finds local midnight', () => {
		expect(startOfOrgDay('2026-01-16', NY)).toBe(Date.UTC(2026, 0, 16, 5, 0));
	});
});

describe('nextWallTime', () => {
	it('returns later today when the time is still ahead', () => {
		const now = wallTimeToInstant('2026-01-15', '07:00', NY);
		expect(nextWallTime(now, NY, '08:00')).toBe(wallTimeToInstant('2026-01-15', '08:00', NY));
	});

	it('returns tomorrow once the time has passed', () => {
		const now = wallTimeToInstant('2026-01-15', '22:00', NY);
		expect(nextWallTime(now, NY, '08:00')).toBe(wallTimeToInstant('2026-01-16', '08:00', NY));
		const exactly = wallTimeToInstant('2026-01-15', '08:00', NY);
		expect(nextWallTime(exactly, NY, '08:00')).toBe(wallTimeToInstant('2026-01-16', '08:00', NY));
	});

	it('crosses a daylight-saving change', () => {
		const now = wallTimeToInstant('2026-03-07', '22:00', NY);
		expect(nextWallTime(now, NY, '08:00')).toBe(Date.UTC(2026, 2, 8, 12, 0));
	});
});
