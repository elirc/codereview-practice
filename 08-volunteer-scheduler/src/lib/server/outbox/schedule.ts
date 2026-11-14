import { nextWallTime, orgWallTime } from '../../domain/time';

const MINUTE_MS = 60_000;
const BACKOFF_MS = [1 * MINUTE_MS, 5 * MINUTE_MS, 25 * MINUTE_MS, 120 * MINUTE_MS];

export const MAX_ATTEMPTS = 5;
export const QUIET_HOURS_START = '21:00';
export const QUIET_HOURS_END = '08:00';

/** Delay before the next attempt after `attempts` failed attempts. */
export function backoffMs(attempts: number): number {
	const index = Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1;
	return BACKOFF_MS[index];
}

export function isQuietHours(now: number, zone: string): boolean {
	const time = orgWallTime(now, zone);
	return time >= QUIET_HOURS_START || time < QUIET_HOURS_END;
}

export function quietHoursEnd(now: number, zone: string): number {
	return nextWallTime(now, zone, QUIET_HOURS_END);
}
