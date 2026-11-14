import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, sql } from 'drizzle-orm';
import { addDays, type CivilDate } from '../../domain/dates';
import {
	isOccurrence,
	occurrences,
	sameRule,
	WEEKDAYS,
	type Frequency,
	type RecurrenceRule,
	type Weekday
} from '../../domain/recurrence';
import { orgDate, wallTimeToInstant } from '../../domain/time';
import type { AppContext } from '../context';
import { IMMEDIATE, type Tx } from '../db/client';
import {
	seriesExceptions,
	shiftSeries,
	shifts,
	type SeriesExceptionRow,
	type ShiftRow,
	type ShiftSeriesRow
} from '../db/schema';
import { DomainError, notFound } from '../errors';
import {
	applyShiftChanges,
	cancelShiftTx,
	getShift,
	sameShiftValues,
	type ShiftValues
} from './shifts';

/** Shifts are stored for today and the following 60 days (organisation dates). */
export const HORIZON_DAYS = 60;

const MINUTE_MS = 60_000;

export interface SeriesInput {
	title: string;
	location: string;
	description: string;
	startTime: string;
	durationMinutes: number;
	capacity: number;
	freq: Frequency;
	interval: number;
	byWeekday: Weekday[] | null;
	byMonthDay: number | null;
	dtstart: CivilDate;
	until: CivilDate | null;
	count: number | null;
}

export interface ExceptionInput {
	occurrenceDate: CivilDate;
	kind: 'cancelled' | 'modified';
	startTime?: string;
	durationMinutes?: number;
	capacity?: number;
	location?: string;
}

export function horizon(now: number, zone: string): { today: CivilDate; end: CivilDate } {
	const today = orgDate(now, zone);
	return { today, end: addDays(today, HORIZON_DAYS) };
}

export function parseWeekdays(json: string | null): Weekday[] | null {
	if (json === null) return null;
	const parsed: unknown = JSON.parse(json);
	if (!Array.isArray(parsed)) return null;
	return parsed.filter((day): day is Weekday => WEEKDAYS.includes(day));
}

export function ruleOf(series: ShiftSeriesRow): RecurrenceRule {
	return {
		freq: series.freq,
		interval: series.interval,
		byWeekday: parseWeekdays(series.byWeekday),
		byMonthDay: series.byMonthDay,
		dtstart: series.dtstart,
		until: series.until,
		count: series.count
	};
}

function seriesColumns(input: SeriesInput) {
	return {
		...input,
		byWeekday: input.byWeekday ? JSON.stringify(input.byWeekday) : null
	};
}

function getSeriesRow(tx: Tx, seriesId: string): ShiftSeriesRow {
	const series = tx.select().from(shiftSeries).where(eq(shiftSeries.id, seriesId)).get();
	if (!series) throw notFound('Series not found.');
	return series;
}

function loadExceptions(tx: Tx, seriesId: string): Map<CivilDate, SeriesExceptionRow> {
	const rows = tx
		.select()
		.from(seriesExceptions)
		.where(eq(seriesExceptions.seriesId, seriesId))
		.all();
	return new Map(rows.map((row) => [row.occurrenceDate, row]));
}

/** Concrete shift values for one occurrence, applying a `modified` exception if given. */
export function occurrenceValues(
	series: ShiftSeriesRow,
	date: CivilDate,
	exception: SeriesExceptionRow | undefined,
	zone: string
): ShiftValues {
	const modified = exception?.kind === 'modified' ? exception : undefined;
	const startsAt = wallTimeToInstant(date, modified?.startTime ?? series.startTime, zone);
	const duration = modified?.durationMinutes ?? series.durationMinutes;
	return {
		title: series.title,
		location: modified?.location ?? series.location,
		startsAt,
		endsAt: startsAt + duration * MINUTE_MS,
		capacity: modified?.capacity ?? series.capacity,
		detached: modified !== undefined
	};
}

function insertOccurrence(
	tx: Tx,
	now: number,
	zone: string,
	series: ShiftSeriesRow,
	date: CivilDate,
	exception: SeriesExceptionRow | undefined
): boolean {
	const values = occurrenceValues(series, date, exception, zone);
	if (values.startsAt <= now) return false;
	const result = tx
		.insert(shifts)
		.values({
			id: randomUUID(),
			seriesId: series.id,
			occurrenceDate: date,
			...values,
			detached: values.detached ?? false,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoNothing({ target: [shifts.seriesId, shifts.occurrenceDate] })
		.run();
	return result.changes > 0;
}

/**
 * Inserts the series' occurrences that are not yet stored, from the day after
 * `materializedThrough` (or today) to the end of the horizon.
 */
export function materializeSeries(
	tx: Tx,
	now: number,
	zone: string,
	series: ShiftSeriesRow
): number {
	const { today, end } = horizon(now, zone);
	const through = series.materializedThrough;
	const from = through && through >= today ? addDays(through, 1) : today;
	let inserted = 0;
	if (from <= end) {
		const exceptions = loadExceptions(tx, series.id);
		for (const date of occurrences(ruleOf(series), from, end)) {
			const exception = exceptions.get(date);
			if (exception?.kind === 'cancelled') continue;
			if (insertOccurrence(tx, now, zone, series, date, exception)) inserted += 1;
		}
	}
	if (!through || through < end) {
		tx.update(shiftSeries)
			.set({ materializedThrough: end })
			.where(eq(shiftSeries.id, series.id))
			.run();
	}
	return inserted;
}

/** Materialises one series in its own transaction, reading its current row. */
export function materializeSeriesById(ctx: AppContext, seriesId: string): number {
	const now = ctx.now();
	return ctx.db.transaction(
		(tx) => materializeSeries(tx, now, ctx.zone, getSeriesRow(tx, seriesId)),
		IMMEDIATE
	);
}

export function createSeries(ctx: AppContext, input: SeriesInput): ShiftSeriesRow {
	const now = ctx.now();
	return ctx.db.transaction((tx) => {
		const series = tx
			.insert(shiftSeries)
			.values({ id: randomUUID(), ...seriesColumns(input), createdAt: now, updatedAt: now })
			.returning()
			.get();
		materializeSeries(tx, now, ctx.zone, series);
		return getSeriesRow(tx, series.id);
	}, IMMEDIATE);
}

function applyPatternChange(
	tx: Tx,
	now: number,
	zone: string,
	series: ShiftSeriesRow,
	effectiveFrom: CivilDate,
	end: CivilDate
): void {
	const exceptions = loadExceptions(tx, series.id);
	const wanted = new Set(
		occurrences(ruleOf(series), effectiveFrom, end).filter(
			(date) => exceptions.get(date)?.kind !== 'cancelled'
		)
	);
	const existing = tx
		.select()
		.from(shifts)
		.where(and(eq(shifts.seriesId, series.id), gte(shifts.occurrenceDate, effectiveFrom)))
		.all();
	for (const shift of existing) {
		const date = shift.occurrenceDate ?? '';
		if (shift.status === 'scheduled' && shift.startsAt > now && !wanted.has(date)) {
			cancelShiftTx(tx, now, shift.id);
		}
	}
	const stored = new Set(existing.map((shift) => shift.occurrenceDate));
	for (const date of wanted) {
		if (!stored.has(date)) insertOccurrence(tx, now, zone, series, date, exceptions.get(date));
	}
}

function applyFieldChanges(
	tx: Tx,
	now: number,
	zone: string,
	series: ShiftSeriesRow,
	effectiveFrom: CivilDate
): void {
	const targets = tx
		.select()
		.from(shifts)
		.where(
			and(
				eq(shifts.seriesId, series.id),
				gte(shifts.occurrenceDate, effectiveFrom),
				eq(shifts.status, 'scheduled'),
				eq(shifts.detached, false),
				gt(shifts.startsAt, now)
			)
		)
		.all();
	for (const shift of targets) {
		if (!shift.occurrenceDate) continue;
		const next = occurrenceValues(series, shift.occurrenceDate, undefined, zone);
		if (!sameShiftValues(shift, next)) applyShiftChanges(tx, now, shift, next);
	}
}

/**
 * Edits a series for occurrences on or after `effectiveFrom`. Earlier shifts,
 * shifts that already started and detached occurrences keep their values.
 */
export function updateSeries(
	ctx: AppContext,
	seriesId: string,
	input: SeriesInput,
	effectiveFrom: CivilDate
): ShiftSeriesRow {
	const now = ctx.now();
	const { today, end } = horizon(now, ctx.zone);
	if (effectiveFrom < today || effectiveFrom > end) {
		throw new DomainError(
			'invalid_effective_date',
			422,
			`The effective date must be between ${today} and ${end}.`,
			{ fields: [{ path: 'effectiveFrom', message: 'Out of range.' }] }
		);
	}
	return ctx.db.transaction((tx) => {
		const current = getSeriesRow(tx, seriesId);
		materializeSeries(tx, now, ctx.zone, current);
		const updated = tx
			.update(shiftSeries)
			.set({ ...seriesColumns(input), materializedThrough: end, updatedAt: now })
			.where(eq(shiftSeries.id, seriesId))
			.returning()
			.get();
		if (!sameRule(ruleOf(current), ruleOf(updated))) {
			applyPatternChange(tx, now, ctx.zone, updated, effectiveFrom, end);
		}
		applyFieldChanges(tx, now, ctx.zone, updated, effectiveFrom);
		return updated;
	}, IMMEDIATE);
}

/** Cancels every future scheduled shift and ends the series yesterday. */
export function deleteSeries(ctx: AppContext, seriesId: string): void {
	const now = ctx.now();
	const yesterday = addDays(orgDate(now, ctx.zone), -1);
	ctx.db.transaction((tx) => {
		getSeriesRow(tx, seriesId);
		const future = tx
			.select({ id: shifts.id })
			.from(shifts)
			.where(
				and(
					eq(shifts.seriesId, seriesId),
					eq(shifts.status, 'scheduled'),
					gt(shifts.startsAt, now)
				)
			)
			.all();
		for (const shift of future) cancelShiftTx(tx, now, shift.id);
		tx.update(shiftSeries)
			.set({ until: yesterday, count: null, updatedAt: now })
			.where(eq(shiftSeries.id, seriesId))
			.run();
	}, IMMEDIATE);
}

/** Cancels or modifies a single occurrence of a series. */
export function setException(
	ctx: AppContext,
	seriesId: string,
	input: ExceptionInput
): SeriesExceptionRow {
	const now = ctx.now();
	const { today } = horizon(now, ctx.zone);
	const date = input.occurrenceDate;
	return ctx.db.transaction((tx) => {
		const series = getSeriesRow(tx, seriesId);
		const shift = tx
			.select()
			.from(shifts)
			.where(and(eq(shifts.seriesId, seriesId), eq(shifts.occurrenceDate, date)))
			.get();
		if (!shift && !isOccurrence(ruleOf(series), date)) {
			throw new DomainError(
				'not_an_occurrence',
				422,
				`${date} is not an occurrence of this series.`
			);
		}
		const existing = tx
			.select()
			.from(seriesExceptions)
			.where(
				and(eq(seriesExceptions.seriesId, seriesId), eq(seriesExceptions.occurrenceDate, date))
			)
			.get();
		if (existing?.kind === 'cancelled') {
			throw new DomainError('occurrence_cancelled', 409, 'This occurrence is already cancelled.');
		}
		if ((shift && shift.startsAt <= now) || (!shift && date < today)) {
			throw new DomainError('shift_started', 422, 'This occurrence has already started.');
		}
		if (shift && shift.status === 'cancelled') {
			throw new DomainError('shift_cancelled', 409, 'This shift has been cancelled.');
		}

		const modified = input.kind === 'modified';
		const fields = {
			kind: input.kind,
			startTime: modified ? (input.startTime ?? null) : null,
			durationMinutes: modified ? (input.durationMinutes ?? null) : null,
			capacity: modified ? (input.capacity ?? null) : null,
			location: modified ? (input.location ?? null) : null
		};
		const exception = existing
			? tx
					.update(seriesExceptions)
					.set(fields)
					.where(eq(seriesExceptions.id, existing.id))
					.returning()
					.get()
			: tx
					.insert(seriesExceptions)
					.values({ id: randomUUID(), seriesId, occurrenceDate: date, ...fields, createdAt: now })
					.returning()
					.get();

		if (!modified) {
			if (shift) cancelShiftTx(tx, now, shift.id);
			return exception;
		}
		const next = occurrenceValues(series, date, exception, ctx.zone);
		if (next.startsAt <= now) {
			throw new DomainError('starts_in_past', 422, 'The occurrence must start in the future.');
		}
		if (shift) applyShiftChanges(tx, now, shift, next);
		else insertOccurrence(tx, now, ctx.zone, series, date, exception);
		return exception;
	}, IMMEDIATE);
}

/** Changes one stored occurrence through a `modified` exception. */
export function modifyOccurrence(
	ctx: AppContext,
	shiftId: string,
	overrides: { startTime: string; durationMinutes: number; capacity: number; location: string }
): SeriesExceptionRow {
	const shift = getShift(ctx.db, shiftId);
	if (!shift) throw notFound('Shift not found.');
	if (!shift.seriesId || !shift.occurrenceDate) {
		throw new DomainError('not_a_series_shift', 422, 'This shift is not part of a series.');
	}
	return setException(ctx, shift.seriesId, {
		occurrenceDate: shift.occurrenceDate,
		kind: 'modified',
		...overrides
	});
}

export function listSeries(ctx: AppContext) {
	const now = ctx.now();
	const upcoming = sql<number>`(select count(*) from shifts s where s.series_id = ${shiftSeries.id} and s.status = 'scheduled' and s.starts_at > ${now})`;
	return ctx.db
		.select({ series: shiftSeries, upcoming })
		.from(shiftSeries)
		.orderBy(asc(shiftSeries.title), desc(shiftSeries.createdAt))
		.all();
}

export function getSeriesDetail(ctx: AppContext, seriesId: string) {
	const series = ctx.db.select().from(shiftSeries).where(eq(shiftSeries.id, seriesId)).get();
	if (!series) return null;
	const exceptions = ctx.db
		.select()
		.from(seriesExceptions)
		.where(eq(seriesExceptions.seriesId, seriesId))
		.orderBy(asc(seriesExceptions.occurrenceDate))
		.all();
	const upcoming: ShiftRow[] = ctx.db
		.select()
		.from(shifts)
		.where(and(eq(shifts.seriesId, seriesId), gt(shifts.endsAt, ctx.now())))
		.orderBy(asc(shifts.startsAt))
		.limit(30)
		.all();
	return { series, exceptions, upcoming };
}
