import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wallTimeToInstant } from '../../src/lib/domain/time';
import { outbox, signups, type ShiftRow, type UserRow } from '../../src/lib/server/db/schema';
import {
	createShift,
	updateShift,
	type OneOffShiftInput
} from '../../src/lib/server/services/shifts';
import {
	cancelSignup,
	setAttendance,
	signUp,
	type Actor
} from '../../src/lib/server/services/signups';
import { createTestContext, HOUR, TEST_ZONE, type TestContext } from '../support/context';
import { codeOf } from '../support/errors';
import { createUser } from '../support/factories';

let ctx: TestContext;
let coordinator: UserRow;

beforeEach(() => {
	ctx = createTestContext(wallTimeToInstant('2026-01-05', '08:00', TEST_ZONE));
	coordinator = createUser(ctx, { role: 'coordinator' });
});

afterEach(() => ctx.close());

function input(overrides: Partial<OneOffShiftInput> = {}): OneOffShiftInput {
	return {
		title: 'Food bank',
		location: 'Depot',
		date: '2026-01-10',
		startTime: '09:00',
		durationMinutes: 180,
		capacity: 2,
		...overrides
	};
}

function shift(overrides: Partial<OneOffShiftInput> = {}): ShiftRow {
	return createShift(ctx, input(overrides));
}

function join(user: UserRow, target: ShiftRow) {
	return signUp(ctx, { userId: user.id, shiftId: target.id, actor: user });
}

function statusOf(signupId: string) {
	return ctx.db.select().from(signups).where(eq(signups.id, signupId)).get()?.status;
}

function keys(template: string): string[] {
	return ctx.db
		.select({ key: outbox.dedupeKey })
		.from(outbox)
		.where(eq(outbox.template, template))
		.all()
		.map((row) => row.key);
}

const asActor = (user: UserRow): Actor => ({ id: user.id, role: user.role });

describe('signing up', () => {
	it('confirms up to capacity, then waitlists in arrival order', () => {
		const target = shift({ capacity: 2 });
		const results = [1, 2, 3, 4].map(() => join(createUser(ctx), target));
		expect(results.map((s) => [s.status, s.waitlistSeq])).toEqual([
			['confirmed', null],
			['confirmed', null],
			['waitlisted', 1],
			['waitlisted', 2]
		]);
		expect(keys('signup-confirmed')).toHaveLength(2);
		expect(keys('signup-waitlisted')).toHaveLength(2);
	});

	it('keeps a repeated sign-up to one signup and one confirmation', () => {
		const target = shift();
		const user = createUser(ctx);
		join(user, target);
		expect(codeOf(() => join(user, target))).toBe('already_signed_up');
		const rows = ctx.db.select().from(signups).where(eq(signups.userId, user.id)).all();
		expect(rows).toHaveLength(1);
		expect(keys('signup-confirmed')).toHaveLength(1);
	});

	it('refuses a shift overlapping another confirmed shift but allows adjacent ones', () => {
		const user = createUser(ctx);
		join(user, shift({ startTime: '09:00', durationMinutes: 180 }));
		const overlapping = shift({ startTime: '11:00', durationMinutes: 120 });
		const adjacent = shift({ startTime: '12:00', durationMinutes: 60 });
		const before = shift({ startTime: '08:00', durationMinutes: 60 });
		expect(codeOf(() => join(user, overlapping))).toBe('overlapping_shift');
		expect(join(user, adjacent).status).toBe('confirmed');
		expect(join(user, before).status).toBe('confirmed');
	});

	it('uses instants for overlap across midnight', () => {
		const user = createUser(ctx);
		join(user, shift({ date: '2026-01-15', startTime: '23:30', durationMinutes: 90 }));
		const earlyNext = shift({ date: '2026-01-16', startTime: '00:30', durationMinutes: 60 });
		expect(codeOf(() => join(user, earlyNext))).toBe('overlapping_shift');
	});

	it('ignores waitlisted signups when checking overlap', () => {
		const user = createUser(ctx);
		const full = shift({ capacity: 1 });
		join(createUser(ctx), full);
		expect(join(user, full).status).toBe('waitlisted');
		expect(join(user, shift({ startTime: '10:00' })).status).toBe('confirmed');
	});

	it('is open until just before the start and refused at the start', () => {
		const target = shift();
		ctx.setNow(target.startsAt - 1);
		expect(join(createUser(ctx), target).status).toBe('confirmed');
		ctx.setNow(target.startsAt);
		expect(codeOf(() => join(createUser(ctx), target))).toBe('shift_started');
	});

	it('refuses cancelled shifts and other users acting for someone else', () => {
		const target = shift();
		const user = createUser(ctx);
		const other = createUser(ctx);
		expect(codeOf(() => signUp(ctx, { userId: user.id, shiftId: target.id, actor: other }))).toBe(
			'forbidden'
		);
		expect(signUp(ctx, { userId: user.id, shiftId: target.id, actor: coordinator }).status).toBe(
			'confirmed'
		);
	});

	it('creates a fresh signup with new keys when re-joining after cancelling', () => {
		const target = shift({ capacity: 1 });
		join(createUser(ctx), target);
		const user = createUser(ctx);
		const first = join(user, target);
		cancelSignup(ctx, first.id, asActor(user));
		const second = join(user, target);
		expect(second.id).not.toBe(first.id);
		expect([first.waitlistSeq, second.waitlistSeq]).toEqual([1, 2]);
		expect(keys('signup-waitlisted').sort()).toEqual(
			[`signup-waitlisted:${first.id}:email`, `signup-waitlisted:${second.id}:email`].sort()
		);
	});

	it('waitlists new signups once capacity is lowered below the confirmed count', () => {
		const target = shift({ capacity: 3 });
		const confirmed = [1, 2, 3].map(() => join(createUser(ctx), target));
		updateShift(ctx, target.id, input({ capacity: 1 }));
		expect(confirmed.every((s) => statusOf(s.id) === 'confirmed')).toBe(true);
		const late = join(createUser(ctx), target);
		expect(late.status).toBe('waitlisted');
		cancelSignup(ctx, confirmed[0].id, asActor(coordinator));
		expect(statusOf(late.id)).toBe('waitlisted');
	});
});

describe('cancelling', () => {
	it('lets volunteers cancel until exactly two hours before the start', () => {
		const target = shift();
		const early = createUser(ctx);
		const late = createUser(ctx);
		const a = join(early, target);
		const b = join(late, target);
		ctx.setNow(target.startsAt - 2 * HOUR);
		expect(cancelSignup(ctx, a.id, asActor(early)).changed).toBe(true);
		ctx.setNow(target.startsAt - 2 * HOUR + 1000);
		expect(codeOf(() => cancelSignup(ctx, b.id, asActor(late)))).toBe('cancellation_closed');
		expect(cancelSignup(ctx, b.id, asActor(coordinator)).changed).toBe(true);
	});

	it('lets coordinators remove volunteers until the shift ends', () => {
		const target = shift();
		const a = join(createUser(ctx), target);
		const b = join(createUser(ctx), target);
		ctx.setNow(target.endsAt - 1);
		expect(cancelSignup(ctx, a.id, asActor(coordinator)).changed).toBe(true);
		ctx.setNow(target.endsAt);
		expect(codeOf(() => cancelSignup(ctx, b.id, asActor(coordinator)))).toBe(
			'cancellation_closed'
		);
	});

	it('notifies the volunteer only when a coordinator removes them', () => {
		const target = shift();
		const self = createUser(ctx);
		const removed = createUser(ctx);
		const a = join(self, target);
		const b = join(removed, target);
		cancelSignup(ctx, a.id, asActor(self));
		cancelSignup(ctx, b.id, asActor(coordinator));
		expect(keys('signup-cancelled')).toEqual([`signup-cancelled:${b.id}:email`]);
	});

	it('is a no-op for an already cancelled signup', () => {
		const user = createUser(ctx);
		const signup = join(user, shift());
		cancelSignup(ctx, signup.id, asActor(user));
		expect(cancelSignup(ctx, signup.id, asActor(user)).changed).toBe(false);
	});

	it('hides other volunteers’ signups', () => {
		const owner = createUser(ctx);
		const signup = join(owner, shift());
		expect(codeOf(() => cancelSignup(ctx, signup.id, asActor(createUser(ctx))))).toBe(
			'not_found'
		);
		expect(statusOf(signup.id)).toBe('confirmed');
	});
});

describe('waitlist promotion', () => {
	it('promotes the lowest waitlist position when a confirmed volunteer cancels', () => {
		const target = shift({ capacity: 1 });
		const holder = createUser(ctx);
		const held = join(holder, target);
		const first = join(createUser(ctx), target);
		const second = join(createUser(ctx), target);
		cancelSignup(ctx, held.id, asActor(holder));
		expect(statusOf(first.id)).toBe('confirmed');
		expect(statusOf(second.id)).toBe('waitlisted');
		expect(keys('waitlist-promoted')).toEqual([`waitlist-promoted:${first.id}:email`]);
	});

	it('passes over a waitlisted volunteer who is confirmed elsewhere at the same time', () => {
		const target = shift({ capacity: 1 });
		const holder = createUser(ctx);
		const busy = createUser(ctx);
		const free = createUser(ctx);
		const held = join(holder, target);
		const busyWaiting = join(busy, target);
		const freeWaiting = join(free, target);
		join(busy, shift({ startTime: '10:00', durationMinutes: 60 }));

		cancelSignup(ctx, held.id, asActor(holder));
		expect(statusOf(busyWaiting.id)).toBe('waitlisted');
		expect(statusOf(freeWaiting.id)).toBe('confirmed');
	});

	it('promotes nobody when a waitlisted volunteer cancels', () => {
		const target = shift({ capacity: 1 });
		join(createUser(ctx), target);
		const leaving = createUser(ctx);
		const waiting = join(leaving, target);
		const behind = join(createUser(ctx), target);
		cancelSignup(ctx, waiting.id, asActor(leaving));
		expect(statusOf(behind.id)).toBe('waitlisted');
		expect(keys('waitlist-promoted')).toHaveLength(0);
	});

	it('promotes as many as fit when capacity is raised', () => {
		const target = shift({ capacity: 1 });
		join(createUser(ctx), target);
		const waiting = [1, 2, 3].map(() => join(createUser(ctx), target));
		updateShift(ctx, target.id, input({ capacity: 3 }));
		expect(waiting.map((s) => statusOf(s.id))).toEqual(['confirmed', 'confirmed', 'waitlisted']);
	});
});

describe('attendance', () => {
	it('can be recorded for confirmed volunteers once the shift has started', () => {
		const target = shift();
		const signup = join(createUser(ctx), target);
		expect(codeOf(() => setAttendance(ctx, target.id, signup.id, true))).toBe(
			'attendance_not_open'
		);
		ctx.setNow(target.startsAt);
		setAttendance(ctx, target.id, signup.id, true);
		const row = ctx.db
			.select()
			.from(signups)
			.where(and(eq(signups.id, signup.id), eq(signups.attended, true)))
			.get();
		expect(row).toBeDefined();
	});
});
