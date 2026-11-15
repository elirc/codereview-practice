import { and, asc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { shifts, signups, type SignupRow } from '../db/schema';

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
 * passing over anyone already confirmed on an overlapping shift. Returns
 * the promoted signups; the caller queues their notices.
 */
export function promoteWaitlist(tx: Tx, shift: ShiftWindow & { capacity: number }): SignupRow[] {
	const room = shift.capacity - countConfirmed(tx, shift.id);
	if (room <= 0) return [];
	const free = sql`not exists (
		select 1 from signups other
		join shifts other_shift on other_shift.id = other.shift_id
		where other.user_id = ${signups.userId}
			and other_shift.id <> ${shift.id}
			and other_shift.status = 'scheduled'
			and other_shift.starts_at < ${shift.endsAt}
			and other_shift.ends_at > ${shift.startsAt}
	)`;
	const eligible = tx
		.select()
		.from(signups)
		.where(and(eq(signups.shiftId, shift.id), eq(signups.status, 'waitlisted'), free))
		.orderBy(asc(signups.waitlistSeq))
		.limit(room)
		.all();
	if (eligible.length === 0) return [];
	const ids = eligible.map((signup) => signup.id);
	tx.update(signups).set({ status: 'confirmed' }).where(inArray(signups.id, ids)).run();
	return eligible.map((signup): SignupRow => ({ ...signup, status: 'confirmed' }));
}
