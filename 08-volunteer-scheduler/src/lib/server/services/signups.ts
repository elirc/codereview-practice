import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import { addDays } from '../../domain/dates';
import { startOfOrgDay } from '../../domain/time';
import type { AppContext } from '../context';
import { IMMEDIATE, isUniqueViolation, type Tx } from '../db/client';
import { shifts, signups, users, type Role, type ShiftRow, type SignupRow } from '../db/schema';
import { DomainError, notFound } from '../errors';
import { enqueueSignupNotice } from '../outbox/enqueue';
import { horizon } from './series';
import { confirmedCountSql, getShift, rosters, type RosterEntry } from './shifts';
import {
	countConfirmed,
	hasOverlappingConfirmed,
	nextWaitlistSeq,
	promoteWaitlist
} from './waitlist';

export const VOLUNTEER_CANCEL_CUTOFF_MS = 2 * 60 * 60 * 1000;

export interface Actor {
	id: string;
	role: Role;
}

function isManager(actor: Actor): boolean {
	return actor.role === 'coordinator' || actor.role === 'admin';
}

function signupScope(actor: Actor, shiftId: string | undefined): SQL | undefined {
	if (shiftId) return eq(signups.shiftId, shiftId);
	return isManager(actor) ? undefined : eq(signups.userId, actor.id);
}

function alreadySignedUp(): DomainError {
	return new DomainError('already_signed_up', 409, 'You are already signed up for this shift.');
}

/**
 * Signs a user up for a shift: confirmed while there is room, otherwise
 * waitlisted at the back of the queue.
 */
export function signUp(
	ctx: AppContext,
	input: { userId: string; shiftId: string; actor: Actor }
): SignupRow {
	const { userId, shiftId, actor } = input;
	if (actor.id !== userId && !isManager(actor)) {
		throw new DomainError('forbidden', 403, 'You can only sign yourself up.');
	}
	const now = ctx.now();
	try {
		return ctx.db.transaction((tx) => {
			const shift = getShift(tx, shiftId);
			if (!shift) throw notFound('Shift not found.');
			if (shift.status !== 'scheduled') {
				throw new DomainError('shift_cancelled', 409, 'This shift has been cancelled.');
			}
			if (now >= shift.startsAt) {
				throw new DomainError('shift_started', 422, 'This shift has already started.');
			}
			const user = tx.select().from(users).where(eq(users.id, userId)).get();
			if (!user) throw notFound('User not found.');
			if (!user.active) throw new DomainError('user_inactive', 422, 'This account is deactivated.');

			const existing = tx
				.select({ id: signups.id })
				.from(signups)
				.where(
					and(
						eq(signups.shiftId, shiftId),
						eq(signups.userId, userId),
						ne(signups.status, 'cancelled')
					)
				)
				.get();
			if (existing) throw alreadySignedUp();
			if (hasOverlappingConfirmed(tx, userId, shift)) {
				throw new DomainError(
					'overlapping_shift',
					422,
					'You are already confirmed for another shift at this time.'
				);
			}

			const hasRoom = countConfirmed(tx, shiftId) < shift.capacity;
			const signup = tx
				.insert(signups)
				.values({
					id: randomUUID(),
					shiftId,
					userId,
					status: hasRoom ? 'confirmed' : 'waitlisted',
					waitlistSeq: hasRoom ? null : nextWaitlistSeq(tx, shiftId),
					createdAt: now
				})
				.returning()
				.get();
			enqueueSignupNotice(tx, now, hasRoom ? 'signup-confirmed' : 'signup-waitlisted', signup);
			return signup;
		}, IMMEDIATE);
	} catch (err) {
		if (isUniqueViolation(err)) throw alreadySignedUp();
		throw err;
	}
}

/**
 * Cancels a signup. Volunteers may cancel their own until two hours before
 * the start; coordinators may remove anyone until the shift ends.
 */
export function cancelSignup(
	ctx: AppContext,
	signupId: string,
	actor: Actor,
	options: { shiftId?: string } = {}
): { signup: SignupRow; changed: boolean } {
	const now = ctx.now();
	const outcome = ctx.db.transaction((tx) => {
		const signup = tx
			.select()
			.from(signups)
			.where(and(eq(signups.id, signupId), signupScope(actor, options.shiftId)))
			.get();
		if (!signup) throw notFound('Signup not found.');
		if (signup.status === 'cancelled') return { signup, changed: false, promoted: [] };

		const shift = getShift(tx, signup.shiftId);
		if (!shift) throw notFound('Shift not found.');
		const closesAt = isManager(actor) ? shift.endsAt : shift.startsAt - VOLUNTEER_CANCEL_CUTOFF_MS;
		const open = isManager(actor) ? now < closesAt : now <= closesAt;
		if (!open) {
			throw new DomainError(
				'cancellation_closed',
				422,
				'It is too late to cancel this signup; please contact a coordinator.'
			);
		}

		const cancelled = tx
			.update(signups)
			.set({ status: 'cancelled', cancelledAt: now })
			.where(eq(signups.id, signup.id))
			.returning()
			.get();
		if (actor.id !== signup.userId) {
			enqueueSignupNotice(tx, now, 'signup-cancelled', signup);
		}
		const promoted =
			signup.status === 'confirmed' && shift.status === 'scheduled'
				? promoteWaitlist(tx, shift)
				: [];
		return { signup: cancelled, changed: true, promoted };
	}, IMMEDIATE);
	for (const signup of outcome.promoted) {
		enqueueSignupNotice(ctx.db, now, 'waitlist-promoted', signup);
	}
	return { signup: outcome.signup, changed: outcome.changed };
}

/** Records attendance for a confirmed signup once the shift has started. */
export function setAttendance(
	ctx: AppContext,
	shiftId: string,
	signupId: string,
	attended: boolean
): void {
	const now = ctx.now();
	ctx.db.transaction((tx) => {
		const shift = getShift(tx, shiftId);
		if (!shift) throw notFound('Shift not found.');
		if (now < shift.startsAt) {
			throw new DomainError(
				'attendance_not_open',
				422,
				'Attendance can be recorded once the shift has started.'
			);
		}
		const signup = tx
			.select()
			.from(signups)
			.where(and(eq(signups.id, signupId), eq(signups.shiftId, shiftId)))
			.get();
		if (!signup) throw notFound('Signup not found.');
		if (signup.status !== 'confirmed') {
			throw new DomainError('not_confirmed', 422, 'Only confirmed volunteers can attend.');
		}
		tx.update(signups).set({ attended }).where(eq(signups.id, signupId)).run();
	}, IMMEDIATE);
}

/** 1-based place in the waitlist among signups still waiting. */
function waitlistPositions(tx: Tx, mine: SignupRow[]): Map<string, number> {
	const positions = new Map<string, number>();
	for (const signup of mine) {
		if (signup.status !== 'waitlisted' || signup.waitlistSeq === null) continue;
		const row = tx
			.select({ ahead: sql<number>`count(*)` })
			.from(signups)
			.where(
				and(
					eq(signups.shiftId, signup.shiftId),
					eq(signups.status, 'waitlisted'),
					lt(signups.waitlistSeq, signup.waitlistSeq)
				)
			)
			.get();
		positions.set(signup.id, (row?.ahead ?? 0) + 1);
	}
	return positions;
}

export interface UpcomingShift {
	shift: ShiftRow;
	confirmed: number;
	/** Confirmed volunteers, in roster order. */
	going: RosterEntry[];
	mine: { signupId: string; status: 'confirmed' | 'waitlisted'; position: number | null } | null;
}

/** Scheduled shifts starting from now through the horizon, with the user's own status. */
export function listUpcoming(ctx: AppContext, userId: string): UpcomingShift[] {
	const now = ctx.now();
	const { end } = horizon(now, ctx.zone);
	const rows = ctx.db
		.select({ shift: shifts, confirmed: confirmedCountSql })
		.from(shifts)
		.where(
			and(
				eq(shifts.status, 'scheduled'),
				gt(shifts.startsAt, now),
				lt(shifts.startsAt, startOfOrgDay(addDays(end, 1), ctx.zone))
			)
		)
		.orderBy(asc(shifts.startsAt), asc(shifts.id))
		.all();
	const ids = rows.map((row) => row.shift.id);
	const mine =
		ids.length === 0
			? []
			: ctx.db
					.select()
					.from(signups)
					.where(
						and(
							eq(signups.userId, userId),
							ne(signups.status, 'cancelled'),
							inArray(signups.shiftId, ids)
						)
					)
					.all();
	const positions = waitlistPositions(ctx.db, mine);
	const byShift = new Map(mine.map((signup) => [signup.shiftId, signup]));
	const going = new Map<string, RosterEntry[]>();
	for (const entry of rosters(ctx.db, ids)) {
		if (entry.status !== 'confirmed') continue;
		going.set(entry.shiftId, [...(going.get(entry.shiftId) ?? []), entry]);
	}
	return rows.map(({ shift, confirmed }) => {
		const signup = byShift.get(shift.id);
		return {
			shift,
			confirmed,
			going: going.get(shift.id) ?? [],
			mine:
				signup && signup.status !== 'cancelled'
					? {
							signupId: signup.id,
							status: signup.status,
							position: positions.get(signup.id) ?? null
						}
					: null
		};
	});
}

export interface MySignup {
	signup: SignupRow;
	shift: ShiftRow;
	position: number | null;
	cancellableUntil: number;
}

/** The user's active signups on shifts that have not ended, soonest first. */
export function listMySignups(ctx: AppContext, userId: string): MySignup[] {
	const now = ctx.now();
	const rows = ctx.db
		.select({ signup: signups, shift: shifts })
		.from(signups)
		.innerJoin(shifts, eq(signups.shiftId, shifts.id))
		.where(
			and(
				eq(signups.userId, userId),
				inArray(signups.status, ['confirmed', 'waitlisted']),
				gt(shifts.endsAt, now)
			)
		)
		.orderBy(asc(shifts.startsAt))
		.all();
	const positions = waitlistPositions(ctx.db, rows.map((row) => row.signup));
	return rows.map(({ signup, shift }) => ({
		signup,
		shift,
		position: positions.get(signup.id) ?? null,
		cancellableUntil: shift.startsAt - VOLUNTEER_CANCEL_CUTOFF_MS
	}));
}
