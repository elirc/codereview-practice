import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wallTimeToInstant } from '../../src/lib/domain/time';
import { outbox, shifts, signups } from '../../src/lib/server/db/schema';
import { enqueueSignupNotice } from '../../src/lib/server/outbox/enqueue';
import { createSeries } from '../../src/lib/server/services/series';
import { createShift } from '../../src/lib/server/services/shifts';
import { signUp } from '../../src/lib/server/services/signups';
import { createTestContext, DAY, TEST_ZONE, type TestContext } from '../support/context';
import { createShiftRow, createSignupRow, createUser } from '../support/factories';
import { runConcurrently } from '../support/processes';

let ctx: TestContext;

beforeEach(() => {
	ctx = createTestContext(wallTimeToInstant('2026-01-05', '08:00', TEST_ZONE));
});

afterEach(() => ctx.close());

function newShift(capacity: number) {
	return createShift(ctx, {
		title: 'Distribution',
		location: 'Warehouse',
		date: '2026-01-12',
		startTime: '10:00',
		durationMinutes: 120,
		capacity
	});
}

function confirmedCount(shiftId: string): number {
	return ctx.db
		.select()
		.from(signups)
		.where(and(eq(signups.shiftId, shiftId), eq(signups.status, 'confirmed')))
		.all().length;
}

describe('sign-ups from separate processes', () => {
	it('give the last spot to exactly one of two volunteers', async () => {
		const shift = newShift(2);
		const early = createUser(ctx);
		signUp(ctx, { userId: early.id, shiftId: shift.id, actor: early });
		const [a, b] = [createUser(ctx), createUser(ctx)];

		const results = await runConcurrently(
			[a, b].map((user) => ['signup', ctx.path, String(ctx.now()), user.id, shift.id])
		);
		const statuses = results.map((result) => (result as { status: string }).status).sort();
		expect(statuses).toEqual(['confirmed', 'waitlisted']);
		expect(confirmedCount(shift.id)).toBe(2);
		const waitlisted = ctx.db
			.select()
			.from(signups)
			.where(and(eq(signups.shiftId, shift.id), eq(signups.status, 'waitlisted')))
			.all();
		expect(waitlisted.map((row) => row.waitlistSeq)).toEqual([1]);
	});

	it('never confirm more volunteers than the capacity', async () => {
		const shift = newShift(2);
		const users = [1, 2, 3, 4].map(() => createUser(ctx));
		const results = await runConcurrently(
			users.map((user) => ['signup', ctx.path, String(ctx.now()), user.id, shift.id])
		);
		const statuses = results.map((result) => (result as { status: string }).status).sort();
		expect(statuses).toEqual(['confirmed', 'confirmed', 'waitlisted', 'waitlisted']);
		expect(confirmedCount(shift.id)).toBe(2);
		const seqs = ctx.db
			.select({ seq: signups.waitlistSeq })
			.from(signups)
			.where(eq(signups.status, 'waitlisted'))
			.all()
			.map((row) => row.seq)
			.sort();
		expect(seqs).toEqual([1, 2]);
	});

	it('record a double-clicked sign-up once with one confirmation', async () => {
		const shift = newShift(3);
		const user = createUser(ctx);
		const args = ['signup', ctx.path, String(ctx.now()), user.id, shift.id];
		const results = await runConcurrently([args, args]);
		expect(results).toContainEqual({ status: 'confirmed' });
		expect(results).toContainEqual({ error: 'already_signed_up' });
		expect(ctx.db.select().from(signups).all()).toHaveLength(1);
		expect(ctx.db.select().from(outbox).all()).toHaveLength(1);
	});
});

describe('dispatchers in separate processes', () => {
	it('never claim the same outbox row', async () => {
		const shift = createShiftRow(ctx);
		for (let i = 0; i < 30; i++) {
			const signup = createSignupRow(ctx, shift.id, createUser(ctx).id);
			enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		}
		const args = ['claim', ctx.path, String(ctx.now())];
		const results = (await runConcurrently([args, args])) as { ids: string[] }[];
		const ids = results.flatMap((result) => result.ids);
		expect(results.map((result) => result.ids.length).sort((x, y) => x - y)).toEqual([10, 20]);
		expect(new Set(ids).size).toBe(30);
		const rows = ctx.db.select().from(outbox).all();
		expect(rows.every((row) => row.status === 'sending' && row.attempts === 1)).toBe(true);
	});
});

describe('materialisation from separate processes', () => {
	it('creates each occurrence once when request and worker race', async () => {
		const series = createSeries(ctx, {
			title: 'Daily sort',
			location: 'Depot',
			description: '',
			startTime: '09:00',
			durationMinutes: 60,
			capacity: 2,
			freq: 'DAILY',
			interval: 1,
			byWeekday: null,
			byMonthDay: null,
			dtstart: '2026-01-05',
			until: null,
			count: null
		});
		const later = String(ctx.now() + 14 * DAY);
		const args = ['materialize', ctx.path, later, series.id];
		const results = (await runConcurrently([args, args])) as { inserted: number }[];
		expect(results.map((result) => result.inserted).sort((x, y) => x - y)).toEqual([0, 14]);
		const dates = ctx.db
			.select({ date: shifts.occurrenceDate })
			.from(shifts)
			.where(eq(shifts.seriesId, series.id))
			.orderBy(shifts.startsAt)
			.all()
			.map((row) => row.date);
		expect(new Set(dates).size).toBe(dates.length);
		expect(dates.at(-1)).toBe('2026-03-20');
	});
});
