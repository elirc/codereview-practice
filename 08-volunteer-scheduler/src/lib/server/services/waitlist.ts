import { and, asc, eq, gt, lt, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { shifts, signups, type SignupRow } from '../db/schema';
import { enqueueSignupNotice } from '../outbox/enqueue';

interface ShiftWindow {
	id: string;
	startsAt: number;
	endsAt: number;
}

export function countConfirmed(tx: Tx, shiftId: string): number {
	const row = tx
		.select({ n: sql<number>`count(*)` })
		.from(signups)
		.where(and(eq(signups.shiftId, shiftId), eq(signups.status, 'confirmed')))
		.get();
	return row?.n ?? 0;
}

/** Whether the user holds a confirmed place on another scheduled shift overlapping this one. */
export function hasOverlappingConfirmed(tx: Tx, userId: string, shift: ShiftWindow): boolean {
	const clash = tx
		.select({ id: signups.id })
		.from(signups)
		.innerJoin(shifts, eq(signups.shiftId, shifts.id))
		.where(
			and(
				eq(signups.userId, userId),
				eq(signups.status, 'confirmed'),
				eq(shifts.status, 'scheduled'),
				ne(shifts.id, shift.id),
				lt(shifts.startsAt, shift.endsAt),
				gt(shifts.endsAt, shift.startsAt)
			)
		)
		.limit(1)
		.get();
	return clash !== undefined;
}

export function nextWaitlistSeq(tx: Tx, shiftId: string): number {
	const row = tx
		.select({ max: sql<number | null>`max(${signups.waitlistSeq})` })
		.from(signups)
		.where(eq(signups.shiftId, shiftId))
		.get();
	return (row?.max ?? 0) + 1;
}

/**
 * Confirms waitlisted signups in waitlist order while the shift has room,
 * passing over anyone already confirmed on an overlapping shift.
 */
export function promoteWaitlist(
	tx: Tx,
	now: number,
	shift: ShiftWindow & { capacity: number }
): SignupRow[] {
	let confirmed = countConfirmed(tx, shift.id);
	if (confirmed >= shift.capacity) return [];
	const waiting = tx
		.select()
		.from(signups)
		.where(and(eq(signups.shiftId, shift.id), eq(signups.status, 'waitlisted')))
		.orderBy(asc(signups.waitlistSeq))
		.all();
	const promoted: SignupRow[] = [];
	for (const signup of waiting) {
		if (confirmed >= shift.capacity) break;
		if (hasOverlappingConfirmed(tx, signup.userId, shift)) continue;
		tx.update(signups).set({ status: 'confirmed' }).where(eq(signups.id, signup.id)).run();
		enqueueSignupNotice(tx, now, 'waitlist-promoted', signup);
		promoted.push({ ...signup, status: 'confirmed' });
		confirmed += 1;
	}
	return promoted;
}
