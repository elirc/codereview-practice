import { DateTime } from 'luxon';
import { addDays, civilDate, parseCivilDate, parseWallTime, type CivilDate } from './dates';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const LOCALE = 'en-US';

function pad2(value: number): string {
	return String(value).padStart(2, '0');
}

/** UTC offset of `zone` at `instant`, in milliseconds (east positive). */
export function offsetAt(instant: number, zone: string): number {
	return DateTime.fromMillis(instant, { zone }).offset * MINUTE_MS;
}

/**
 * Resolves a wall-clock time on a civil date in `zone` to an instant.
 * Times inside a forward transition move later by the size of the gap;
 * times that occur twice resolve to the earlier occurrence.
 */
export function wallTimeToInstant(date: CivilDate, time: string, zone: string): number {
	const { year, month, day } = parseCivilDate(date);
	const { hour, minute } = parseWallTime(time);
	const local = Date.UTC(year, month - 1, day, hour, minute);
	const before = offsetAt(local - DAY_MS, zone);
	const after = offsetAt(local + DAY_MS, zone);
	const matches = [before, after]
		.map((offset) => local - offset)
		.filter((instant) => instant + offsetAt(instant, zone) === local);
	if (matches.length > 0) return Math.min(...matches);
	return local - before;
}

export function orgDate(instant: number, zone: string): CivilDate {
	const dt = DateTime.fromMillis(instant, { zone });
	return civilDate(dt.year, dt.month, dt.day);
}

export function orgWallTime(instant: number, zone: string): string {
	const dt = DateTime.fromMillis(instant, { zone });
	return `${pad2(dt.hour)}:${pad2(dt.minute)}`;
}

export function startOfOrgDay(date: CivilDate, zone: string): number {
	return wallTimeToInstant(date, '00:00', zone);
}

/** The first instant strictly after `now` at which the wall clock in `zone` reads `time`. */
export function nextWallTime(now: number, zone: string, time: string): number {
	const today = orgDate(now, zone);
	const candidate = wallTimeToInstant(today, time, zone);
	return candidate > now ? candidate : wallTimeToInstant(addDays(today, 1), time, zone);
}

/** ISO-8601 with the zone's offset, e.g. `2026-03-08T03:30:00-04:00`. */
export function isoWithOffset(instant: number, zone: string): string {
	return DateTime.fromMillis(instant, { zone }).toFormat("yyyy-MM-dd'T'HH:mm:ssZZ");
}

/** Human-readable local time, e.g. `Sun 8 Mar 2026, 03:30 EDT`. */
export function formatInstant(instant: number, zone: string): string {
	const dt = DateTime.fromMillis(instant, { zone, locale: LOCALE });
	return dt.toFormat('ccc d LLL yyyy, HH:mm ZZZZ');
}

export function formatDate(date: CivilDate): string {
	const { year, month, day } = parseCivilDate(date);
	const dt = DateTime.fromObject({ year, month, day }, { zone: 'UTC', locale: LOCALE });
	return dt.toFormat('cccc d LLLL yyyy');
}
