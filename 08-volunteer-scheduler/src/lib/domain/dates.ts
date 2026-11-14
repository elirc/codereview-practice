/** A calendar date as `YYYY-MM-DD`, with no time zone attached. */
export type CivilDate = string;

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function pad(value: number, width: number): string {
	return String(value).padStart(width, '0');
}

export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function civilDate(year: number, month: number, day: number): CivilDate {
	return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

export function parseCivilDate(date: CivilDate): { year: number; month: number; day: number } {
	const match = DATE_PATTERN.exec(date);
	if (!match) throw new RangeError(`Invalid civil date: ${date}`);
	return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function isCivilDate(value: string): boolean {
	const match = DATE_PATTERN.exec(value);
	if (!match) return false;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function isWallTime(value: string): boolean {
	return TIME_PATTERN.test(value);
}

export function parseWallTime(time: string): { hour: number; minute: number } {
	const match = TIME_PATTERN.exec(time);
	if (!match) throw new RangeError(`Invalid wall time: ${time}`);
	return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Days since 1970-01-01. */
export function toDayNumber(date: CivilDate): number {
	const { year, month, day } = parseCivilDate(date);
	return Date.UTC(year, month - 1, day) / DAY_MS;
}

export function fromDayNumber(dayNumber: number): CivilDate {
	const d = new Date(dayNumber * DAY_MS);
	return civilDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function addDays(date: CivilDate, days: number): CivilDate {
	return fromDayNumber(toDayNumber(date) + days);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: CivilDate, to: CivilDate): number {
	return toDayNumber(to) - toDayNumber(from);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(date: CivilDate): number {
	// 1970-01-01 was a Thursday.
	return (((toDayNumber(date) + 3) % 7) + 7) % 7;
}

export function minDate(a: CivilDate, b: CivilDate): CivilDate {
	return a < b ? a : b;
}

export function maxDate(a: CivilDate, b: CivilDate): CivilDate {
	return a > b ? a : b;
}
