import { DateTime, IANAZone } from "luxon";

/** A civil date, `YYYY-MM-DD`, with no zone attached. */
export type LocalDate = string;
/** A wall-clock time, `HH:MM`, interpreted in some zone on some date. */
export type WallTime = string;

export interface TimeRange {
  startsAt: DateTime;
  endsAt: DateTime;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

export function isLocalDate(value: string): boolean {
  return LOCAL_DATE_PATTERN.test(value) && DateTime.fromISO(value, { zone: "utc" }).isValid;
}

export function isWallTime(value: string): boolean {
  return WALL_TIME_PATTERN.test(value);
}

/** Minutes since midnight for an `HH:MM` wall time. */
export function wallTimeToMinutes(value: WallTime): number {
  const match = WALL_TIME_PATTERN.exec(value);
  if (!match) throw new RangeError(`Invalid wall time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesToWallTime(minutes: number): WallTime {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function civil(date: LocalDate): DateTime {
  const parsed = LOCAL_DATE_PATTERN.test(date) ? DateTime.fromISO(date, { zone: "utc" }) : null;
  if (!parsed || !parsed.isValid) throw new RangeError(`Invalid local date: ${date}`);
  return parsed;
}

function offsetMinutesAt(epochMs: number, zone: string): number {
  return DateTime.fromMillis(epochMs, { zone }).offset;
}

/**
 * Converts a wall-clock time on a civil date in `zone` to an instant.
 *
 * Returns `null` when the wall time does not exist (a forward transition skips it) and the
 * earlier instant when it occurs twice (a backward transition repeats it).
 */
export function resolveLocal(date: LocalDate, time: WallTime, zone: string): DateTime | null {
  const day = civil(date);
  const minutes = wallTimeToMinutes(time);
  const wallAsUtcMs = day.plus({ minutes }).toMillis();

  // Every offset in effect within a day either side covers both sides of any transition.
  const offsets = new Set([
    offsetMinutesAt(wallAsUtcMs - DAY_MS, zone),
    offsetMinutesAt(wallAsUtcMs, zone),
    offsetMinutesAt(wallAsUtcMs + DAY_MS, zone),
  ]);

  const matches: number[] = [];
  for (const offset of offsets) {
    const candidateMs = wallAsUtcMs - offset * MINUTE_MS;
    const local = DateTime.fromMillis(candidateMs, { zone });
    if (
      local.year === day.year &&
      local.month === day.month &&
      local.day === day.day &&
      local.hour * 60 + local.minute === minutes
    ) {
      matches.push(candidateMs);
    }
  }

  if (matches.length === 0) return null;
  return DateTime.fromMillis(Math.min(...matches), { zone: "utc" });
}

/** The first instant whose local date in `zone` is `date`. */
export function localDayStart(date: LocalDate, zone: string): DateTime {
  const midnight = resolveLocal(date, "00:00", zone);
  if (midnight) return midnight;
  // Midnight was skipped, so the day begins at the transition itself, which is where
  // midnight would fall under the offset in force before it.
  const wallAsUtcMs = civil(date).toMillis();
  const offsetBefore = offsetMinutesAt(wallAsUtcMs - DAY_MS, zone);
  return DateTime.fromMillis(wallAsUtcMs - offsetBefore * MINUTE_MS, { zone: "utc" });
}

/** The local day as a half-open instant range `[start, end)`; 23 or 25 hours on transition days. */
export function localDayRange(date: LocalDate, zone: string): { start: DateTime; end: DateTime } {
  return { start: localDayStart(date, zone), end: localDayStart(addDays(date, 1), zone) };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return civil(date).plus({ days }).toFormat("yyyy-MM-dd");
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  return civil(date).weekday;
}

export function localDateOf(instant: DateTime, zone: string): LocalDate {
  return instant.setZone(zone).toFormat("yyyy-MM-dd");
}

/** Number of calendar days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round(civil(to).diff(civil(from), "days").days);
}

export function enumerateDates(from: LocalDate, to: LocalDate): LocalDate[] {
  const count = daysBetween(from, to);
  const dates: LocalDate[] = [];
  for (let i = 0; i <= count; i += 1) dates.push(addDays(from, i));
  return dates;
}

export function overlaps(a: TimeRange, b: TimeRange): boolean {
  const [aStart, aEnd] = [a.startsAt.toMillis(), a.endsAt.toMillis()];
  const [bStart, bEnd] = [b.startsAt.toMillis(), b.endsAt.toMillis()];
  return aStart < bEnd && bStart < aEnd;
}
