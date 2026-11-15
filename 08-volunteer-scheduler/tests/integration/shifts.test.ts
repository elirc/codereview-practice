import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orgWallTime, wallTimeToInstant } from '../../src/lib/domain/time';
import { outbox, seriesExceptions, shifts, signups } from '../../src/lib/server/db/schema';
import { createSeries } from '../../src/lib/server/services/series';
import {
	cancelShift,
	createShift,
	getShift,
	listShifts,
	updateShift,
	type OneOffShiftInput
} from '../../src/lib/server/services/shifts';
import { actions as shiftActions } from '../../src/routes/manage/shifts/[id]/+page.server';
import { createTestContext, TEST_ZONE, type TestContext } from '../support/context';
import { codeOf } from '../support/errors';
import { fakeEvent, failureOf } from '../support/events';
import { createSignupRow, createUser } from '../support/factories';

let ctx: TestContext;

beforeEach(() => {
	ctx = createTestContext(wallTimeToInstant('2026-01-05', '08:00', TEST_ZONE));
});

afterEach(() => ctx.close());

function oneOff(overrides: Partial<OneOffShiftInput> = {}): OneOffShiftInput {
	return {
		title: 'Warehouse sort',
		location: 'Depot',
		date: '2026-01-10',
		startTime: '09:00',
		durationMinutes: 180,
		capacity: 2,
		...overrides
	};
}

function signupStatuses(shiftId: string) {
	return ctx.db
		.select({ userId: signups.userId, status: signups.status })
		.from(signups)
		.where(eq(signups.shiftId, shiftId))
		.all();
}

describe('one-off shifts', () => {
	it('are created in the organisation zone and must start in the future', () => {
		const shift = createShift(ctx, oneOff());
		expect(shift.startsAt).toBe(wallTimeToInstant('2026-01-10', '09:00', TEST_ZONE));
		expect(shift.endsAt - shift.startsAt).toBe(180 * 60_000);
		expect(codeOf(() => createShift(ctx, oneOff({ date: '2026-01-05', startTime: '07:00' })))).toBe(
			'starts_in_past'
		);
	});

	it('are listed under their local start date even when they end the next day', () => {
		const input = oneOff({ date: '2026-01-15', startTime: '23:30', durationMinutes: 90 });
		const late = createShift(ctx, input);
		expect(orgWallTime(late.endsAt, TEST_ZONE)).toBe('01:00');
		const onDay = listShifts(ctx, { from: '2026-01-15', to: '2026-01-15' });
		const nextDay = listShifts(ctx, { from: '2026-01-16', to: '2026-01-16' });
		expect(onDay.map((item) => item.shift.id)).toEqual([late.id]);
		expect(nextDay).toHaveLength(0);
	});

	it('notify confirmed and waitlisted volunteers when the start time changes', () => {
		const shift = createShift(ctx, oneOff({ capacity: 1 }));
		const confirmed = createUser(ctx);
		const waiting = createUser(ctx);
		createSignupRow(ctx, shift.id, confirmed.id, 'confirmed');
		createSignupRow(ctx, shift.id, waiting.id, 'waitlisted', 1);

		updateShift(ctx, shift.id, oneOff({ capacity: 1, title: 'Evening sort' }));
		expect(ctx.db.select().from(outbox).all()).toHaveLength(0);

		const moved = updateShift(ctx, shift.id, oneOff({ capacity: 1, startTime: '10:00' }));
		const keys = ctx.db
			.select({ key: outbox.dedupeKey })
			.from(outbox)
			.all()
			.map((row) => row.key)
			.sort();
		expect(keys).toEqual(
			[confirmed.id, waiting.id]
				.map((id) => `shift-changed:${shift.id}:${moved.startsAt}:${id}:email`)
				.sort()
		);
	});

	it('notify volunteers when the location changes', () => {
		const shift = createShift(ctx, oneOff());
		const volunteer = createUser(ctx, { smsOptIn: true, phone: '+15550100210' });
		createSignupRow(ctx, shift.id, volunteer.id, 'confirmed');

		updateShift(ctx, shift.id, oneOff({ location: 'Annex' }));
		const notices = ctx.db.select().from(outbox).where(eq(outbox.template, 'shift-changed')).all();
		expect(notices.map((row) => `${row.userId}:${row.channel}`).sort()).toEqual([
			`${volunteer.id}:email`,
			`${volunteer.id}:sms`
		]);
		expect(getShift(ctx.db, shift.id)?.location).toBe('Annex');
	});

	it('promote the first waitlisted volunteers when capacity is raised', () => {
		const shift = createShift(ctx, oneOff({ capacity: 1 }));
		createSignupRow(ctx, shift.id, createUser(ctx).id, 'confirmed');
		const waiting = [1, 2, 3].map((seq) => {
			const user = createUser(ctx);
			createSignupRow(ctx, shift.id, user.id, 'waitlisted', seq);
			return user;
		});
		updateShift(ctx, shift.id, oneOff({ capacity: 3 }));
		const byUser = Object.fromEntries(signupStatuses(shift.id).map((s) => [s.userId, s.status]));
		expect(waiting.map((user) => byUser[user.id])).toEqual([
			'confirmed',
			'confirmed',
			'waitlisted'
		]);
		const promoted = ctx.db
			.select()
			.from(outbox)
			.where(eq(outbox.template, 'waitlist-promoted'))
			.all();
		expect(promoted).toHaveLength(2);
	});

	it('keep everyone when capacity drops below the confirmed count', () => {
		const shift = createShift(ctx, oneOff({ capacity: 3 }));
		for (let i = 0; i < 3; i++) createSignupRow(ctx, shift.id, createUser(ctx).id, 'confirmed');
		updateShift(ctx, shift.id, oneOff({ capacity: 1 }));
		expect(signupStatuses(shift.id).every((s) => s.status === 'confirmed')).toBe(true);
		expect(getShift(ctx.db, shift.id)?.capacity).toBe(1);
	});

	it('cannot be edited once started', () => {
		const shift = createShift(ctx, oneOff());
		ctx.setNow(shift.startsAt);
		expect(codeOf(() => updateShift(ctx, shift.id, oneOff({ date: '2026-01-11' })))).toBe(
			'shift_started'
		);
	});
});

describe('cancelling a shift', () => {
	it('cancels all signups and notifies each user once per channel on double submit', async () => {
		const coordinator = createUser(ctx, { role: 'coordinator' });
		const shift = createShift(ctx, oneOff({ capacity: 1 }));
		const sms = createUser(ctx, { smsOptIn: true, phone: '+15550100200' });
		const waiting = createUser(ctx);
		createSignupRow(ctx, shift.id, sms.id, 'confirmed');
		createSignupRow(ctx, shift.id, waiting.id, 'waitlisted', 1);

		for (let i = 0; i < 2; i++) {
			const { event } = fakeEvent({ ctx, user: coordinator, params: { id: shift.id }, form: {} });
			expect(failureOf(await shiftActions.cancel(event))).toBeNull();
		}

		expect(getShift(ctx.db, shift.id)?.status).toBe('cancelled');
		expect(signupStatuses(shift.id).every((s) => s.status === 'cancelled')).toBe(true);
		const notices = ctx.db
			.select()
			.from(outbox)
			.where(eq(outbox.template, 'shift-cancelled'))
			.all();
		expect(notices.map((n) => `${n.userId}:${n.channel}`).sort()).toEqual(
			[`${sms.id}:email`, `${sms.id}:sms`, `${waiting.id}:email`].sort()
		);
	});

	it('is a no-op for a cancelled shift and refused once it has started', () => {
		const shift = createShift(ctx, oneOff());
		expect(cancelShift(ctx, shift.id)).toBe(true);
		expect(cancelShift(ctx, shift.id)).toBe(false);
		const other = createShift(ctx, oneOff({ date: '2026-01-11' }));
		ctx.setNow(other.startsAt);
		expect(codeOf(() => cancelShift(ctx, other.id))).toBe('shift_started');
	});
});

describe('editing a series occurrence from the shift page', () => {
	it('records a modified exception and detaches the shift', async () => {
		const coordinator = createUser(ctx, { role: 'coordinator' });
		const series = createSeries(ctx, {
			title: 'Library tutoring',
			location: 'Room 2',
			description: '',
			startTime: '16:00',
			durationMinutes: 60,
			capacity: 3,
			freq: 'WEEKLY',
			interval: 1,
			byWeekday: ['WE'],
			byMonthDay: null,
			dtstart: '2026-01-05',
			until: null,
			count: null
		});
		const shift = ctx.db
			.select()
			.from(shifts)
			.where(and(eq(shifts.seriesId, series.id), eq(shifts.occurrenceDate, '2026-01-14')))
			.get();
		if (!shift) throw new Error('missing occurrence');
		const { event } = fakeEvent({
			ctx,
			user: coordinator,
			params: { id: shift.id },
			form: { location: 'Room 5', startTime: '17:00', durationMinutes: '60', capacity: '3' }
		});
		expect(failureOf(await shiftActions.update(event))).toBeNull();
		const updated = getShift(ctx.db, shift.id);
		expect(updated).toMatchObject({
			detached: true,
			location: 'Room 5',
			occurrenceDate: '2026-01-14'
		});
		expect(orgWallTime(updated!.startsAt, TEST_ZONE)).toBe('17:00');
		const exception = ctx.db.select().from(seriesExceptions).get();
		expect(exception).toMatchObject({ kind: 'modified', startTime: '17:00', location: 'Room 5' });
	});
});
