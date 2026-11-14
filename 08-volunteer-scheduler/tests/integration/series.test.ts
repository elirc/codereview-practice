import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { occurrences } from '../../src/lib/domain/recurrence';
import { orgWallTime, wallTimeToInstant } from '../../src/lib/domain/time';
import { outbox, shifts, signups, type ShiftRow } from '../../src/lib/server/db/schema';
import {
	createSeries,
	deleteSeries,
	materializeSeriesById,
	ruleOf,
	setException,
	updateSeries,
	type SeriesInput
} from '../../src/lib/server/services/series';
import { createTestContext, DAY, TEST_ZONE, type TestContext } from '../support/context';
import { codeOf } from '../support/errors';
import { createSignupRow, createUser } from '../support/factories';

let ctx: TestContext;

// Monday 5 January 2026, 08:00 in New York.
const START = wallTimeToInstant('2026-01-05', '08:00', TEST_ZONE);

beforeEach(() => {
	ctx = createTestContext(START);
});

afterEach(() => ctx.close());

function weekly(overrides: Partial<SeriesInput> = {}): SeriesInput {
	return {
		title: 'Evening pantry',
		location: 'Main hall',
		description: '',
		startTime: '18:00',
		durationMinutes: 120,
		capacity: 4,
		freq: 'WEEKLY',
		interval: 1,
		byWeekday: ['MO', 'TH'],
		byMonthDay: null,
		dtstart: '2026-01-05',
		until: null,
		count: null,
		...overrides
	};
}

function seriesShifts(seriesId: string): ShiftRow[] {
	return ctx.db
		.select()
		.from(shifts)
		.where(eq(shifts.seriesId, seriesId))
		.orderBy(shifts.startsAt)
		.all();
}

function shiftOn(seriesId: string, date: string): ShiftRow {
	const shift = ctx.db
		.select()
		.from(shifts)
		.where(and(eq(shifts.seriesId, seriesId), eq(shifts.occurrenceDate, date)))
		.get();
	if (!shift) throw new Error(`no shift on ${date}`);
	return shift;
}

function noticesFor(template: string) {
	return ctx.db.select().from(outbox).where(eq(outbox.template, template)).all();
}

describe('materialisation', () => {
	it('creates the occurrences of the next 60 days once, however often it runs', () => {
		const series = createSeries(ctx, weekly());
		const expected = occurrences(ruleOf(series), '2026-01-05', '2026-03-06');
		expect(series.materializedThrough).toBe('2026-03-06');
		expect(seriesShifts(series.id).map((s) => s.occurrenceDate)).toEqual(expected);

		expect(materializeSeriesById(ctx, series.id)).toBe(0);
		expect(materializeSeriesById(ctx, series.id)).toBe(0);
		expect(seriesShifts(series.id)).toHaveLength(expected.length);
	});

	it('extends the horizon as days pass without duplicating anything', () => {
		const series = createSeries(ctx, weekly());
		const before = seriesShifts(series.id).length;
		ctx.advance(7 * DAY);
		expect(materializeSeriesById(ctx, series.id)).toBe(2);
		const dates = seriesShifts(series.id).map((s) => s.occurrenceDate);
		expect(dates).toHaveLength(before + 2);
		expect(new Set(dates).size).toBe(dates.length);
		expect(dates.at(-1)).toBe('2026-03-12');
	});

	it('uses the shifted start time on the spring-forward day', () => {
		ctx.setNow(wallTimeToInstant('2026-03-01', '12:00', TEST_ZONE));
		const input = weekly({ freq: 'DAILY', byWeekday: null, startTime: '02:30', count: 4 });
		const series = createSeries(ctx, { ...input, dtstart: '2026-03-06' });
		const times = seriesShifts(series.id).map((s) => orgWallTime(s.startsAt, TEST_ZONE));
		expect(times).toEqual(['02:30', '02:30', '03:30', '02:30']);
		const gapDay = shiftOn(series.id, '2026-03-08');
		expect(gapDay.endsAt - gapDay.startsAt).toBe(120 * 60_000);
	});

	it('counts a cancelled occurrence against the series count', () => {
		const series = createSeries(
			ctx,
			weekly({ freq: 'DAILY', byWeekday: null, dtstart: '2026-01-06', count: 5 })
		);
		setException(ctx, series.id, { occurrenceDate: '2026-01-07', kind: 'cancelled' });
		materializeSeriesById(ctx, series.id);
		const rows = seriesShifts(series.id);
		expect(rows.filter((s) => s.status === 'scheduled').map((s) => s.occurrenceDate)).toEqual([
			'2026-01-06',
			'2026-01-08',
			'2026-01-09',
			'2026-01-10'
		]);
		expect(rows.map((s) => s.occurrenceDate)).not.toContain('2026-01-11');
	});

	it('never inserts an occurrence cancelled before it was materialised', () => {
		const series = createSeries(ctx, weekly());
		setException(ctx, series.id, { occurrenceDate: '2026-03-09', kind: 'cancelled' });
		ctx.advance(7 * DAY);
		materializeSeriesById(ctx, series.id);
		const dates = seriesShifts(series.id).map((s) => s.occurrenceDate);
		expect(dates).toContain('2026-03-12');
		expect(dates).not.toContain('2026-03-09');
	});
});

describe('exceptions', () => {
	it('moves one occurrence and keeps its occurrence date through re-materialisation', () => {
		const series = createSeries(ctx, weekly());
		setException(ctx, series.id, {
			occurrenceDate: '2026-01-15',
			kind: 'modified',
			startTime: '10:00',
			capacity: 8
		});
		const moved = shiftOn(series.id, '2026-01-15');
		expect(moved).toMatchObject({ detached: true, capacity: 8 });
		expect(orgWallTime(moved.startsAt, TEST_ZONE)).toBe('10:00');
		ctx.advance(3 * DAY);
		materializeSeriesById(ctx, series.id);
		const onDate = seriesShifts(series.id).filter((s) => s.occurrenceDate === '2026-01-15');
		expect(onDate).toHaveLength(1);
	});

	it('cancels a stored occurrence and its signups', () => {
		const series = createSeries(ctx, weekly());
		const shift = shiftOn(series.id, '2026-01-08');
		const volunteer = createUser(ctx);
		createSignupRow(ctx, shift.id, volunteer.id);
		setException(ctx, series.id, { occurrenceDate: '2026-01-08', kind: 'cancelled' });
		expect(shiftOn(series.id, '2026-01-08').status).toBe('cancelled');
		const notices = noticesFor('shift-cancelled');
		expect(notices).toHaveLength(1);
	});

	it('rejects dates that are not occurrences and occurrences already cancelled', () => {
		const series = createSeries(ctx, weekly());
		const tuesday = { occurrenceDate: '2026-01-06', kind: 'cancelled' } as const;
		expect(codeOf(() => setException(ctx, series.id, tuesday))).toBe('not_an_occurrence');
		setException(ctx, series.id, { occurrenceDate: '2026-01-08', kind: 'cancelled' });
		const again = { occurrenceDate: '2026-01-08', kind: 'modified' } as const;
		expect(codeOf(() => setException(ctx, series.id, again))).toBe('occurrence_cancelled');
	});
});

describe('series edits', () => {
	it('changes the time only from the effective date, skipping started and detached shifts', () => {
		const series = createSeries(ctx, weekly());
		setException(ctx, series.id, {
			occurrenceDate: '2026-01-29',
			kind: 'modified',
			startTime: '17:00'
		});
		const volunteer = createUser(ctx);
		const later = shiftOn(series.id, '2026-01-22');
		createSignupRow(ctx, later.id, volunteer.id);

		// Monday 19 January at 18:30: that evening's shift has started.
		ctx.setNow(wallTimeToInstant('2026-01-19', '18:30', TEST_ZONE));
		updateSeries(ctx, series.id, weekly({ startTime: '19:00' }), '2026-01-19');

		const time = (date: string) => orgWallTime(shiftOn(series.id, date).startsAt, TEST_ZONE);
		expect(time('2026-01-15')).toBe('18:00');
		expect(time('2026-01-19')).toBe('18:00');
		expect(time('2026-01-22')).toBe('19:00');
		expect(time('2026-01-29')).toBe('17:00');
		expect(time('2026-02-02')).toBe('19:00');

		const changed = noticesFor('shift-changed');
		expect(changed.map((row) => row.dedupeKey)).toEqual([
			`shift-changed:${later.id}:${shiftOn(series.id, '2026-01-22').startsAt}:${volunteer.id}:email`
		]);
	});

	it('cancels dropped weekdays from the effective date and notifies each volunteer once', () => {
		const series = createSeries(ctx, weekly());
		const volunteer = createUser(ctx, { smsOptIn: true, phone: '+15550100100' });
		const thursday = shiftOn(series.id, '2026-01-22');
		const earlyThursday = shiftOn(series.id, '2026-01-08');
		createSignupRow(ctx, thursday.id, volunteer.id);
		createSignupRow(ctx, earlyThursday.id, volunteer.id);

		updateSeries(ctx, series.id, weekly({ byWeekday: ['MO'] }), '2026-01-12');
		updateSeries(ctx, series.id, weekly({ byWeekday: ['MO'], title: 'Pantry' }), '2026-01-12');

		expect(shiftOn(series.id, '2026-01-08').status).toBe('scheduled');
		expect(shiftOn(series.id, '2026-01-22').status).toBe('cancelled');
		expect(shiftOn(series.id, '2026-01-26').status).toBe('scheduled');
		const signup = ctx.db.select().from(signups).where(eq(signups.shiftId, thursday.id)).get();
		expect(signup?.status).toBe('cancelled');
		const notices = noticesFor('shift-cancelled');
		expect(notices.map((n) => n.channel).sort()).toEqual(['email', 'sms']);
	});

	it('inserts dates that a pattern change adds', () => {
		const series = createSeries(ctx, weekly({ byWeekday: ['MO'] }));
		updateSeries(ctx, series.id, weekly({ byWeekday: ['MO', 'WE'] }), '2026-01-12');
		const dates = seriesShifts(series.id).map((s) => s.occurrenceDate);
		expect(dates).toContain('2026-01-14');
		expect(dates).not.toContain('2026-01-07');
	});

	it('applies a pattern change only from the effective date, then and later', () => {
		const series = createSeries(ctx, weekly({ byWeekday: ['MO'] }));
		updateSeries(ctx, series.id, weekly({ byWeekday: ['TU'] }), '2026-01-20');
		ctx.advance(10 * DAY);
		materializeSeriesById(ctx, series.id);
		const dates = seriesShifts(series.id)
			.filter((s) => s.status === 'scheduled')
			.map((s) => s.occurrenceDate);
		expect(dates).toContain('2026-01-12');
		expect(dates).not.toContain('2026-01-13');
		expect(dates).toContain('2026-01-20');
		expect(dates).not.toContain('2026-01-26');
	});

	it('lowers capacity without removing anyone', () => {
		const series = createSeries(ctx, weekly({ capacity: 3 }));
		const shift = shiftOn(series.id, '2026-01-22');
		for (let i = 0; i < 3; i++) createSignupRow(ctx, shift.id, createUser(ctx).id);
		updateSeries(ctx, series.id, weekly({ capacity: 1 }), '2026-01-12');
		expect(shiftOn(series.id, '2026-01-22').capacity).toBe(1);
		const confirmed = ctx.db
			.select()
			.from(signups)
			.where(and(eq(signups.shiftId, shift.id), eq(signups.status, 'confirmed')))
			.all();
		expect(confirmed).toHaveLength(3);
	});

	it('requires the effective date to fall within the horizon', () => {
		const series = createSeries(ctx, weekly());
		for (const date of ['2026-01-04', '2026-03-07']) {
			expect(codeOf(() => updateSeries(ctx, series.id, weekly(), date))).toBe(
				'invalid_effective_date'
			);
		}
	});
});

describe('deleting a series', () => {
	it('cancels future shifts, keeps past ones and ends the series yesterday', () => {
		const series = createSeries(ctx, weekly());
		ctx.setNow(wallTimeToInstant('2026-01-16', '09:00', TEST_ZONE));
		deleteSeries(ctx, series.id);
		const rows = seriesShifts(series.id);
		const past = rows.filter((s) => s.startsAt <= ctx.now());
		const future = rows.filter((s) => s.startsAt > ctx.now());
		expect(past.length).toBeGreaterThan(0);
		expect(past.every((s) => s.status === 'scheduled')).toBe(true);
		expect(future.every((s) => s.status === 'cancelled')).toBe(true);
		ctx.advance(10 * DAY);
		expect(materializeSeriesById(ctx, series.id)).toBe(0);
	});
});
