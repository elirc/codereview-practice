import { formatInstant, orgDate, orgWallTime } from '../domain/time';
import type { ShiftRow } from './db/schema';

const MINUTE_MS = 60_000;

/** Display fields for a shift, in the organisation zone. */
export function shiftView(shift: ShiftRow, zone: string) {
	return {
		id: shift.id,
		seriesId: shift.seriesId,
		occurrenceDate: shift.occurrenceDate,
		title: shift.title,
		location: shift.location,
		status: shift.status,
		detached: shift.detached,
		capacity: shift.capacity,
		startsAt: shift.startsAt,
		endsAt: shift.endsAt,
		date: orgDate(shift.startsAt, zone),
		startTime: orgWallTime(shift.startsAt, zone),
		endTime: orgWallTime(shift.endsAt, zone),
		endDate: orgDate(shift.endsAt, zone),
		durationMinutes: Math.round((shift.endsAt - shift.startsAt) / MINUTE_MS),
		startsLabel: formatInstant(shift.startsAt, zone)
	};
}

export type ShiftView = ReturnType<typeof shiftView>;

export function timestampLabel(instant: number | null, zone: string): string {
	return instant === null ? '' : formatInstant(instant, zone);
}
