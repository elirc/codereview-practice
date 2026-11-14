import { and, eq, gt, lte } from 'drizzle-orm';
import type { AppContext } from '../context';
import { IMMEDIATE } from '../db/client';
import { shifts, signups } from '../db/schema';
import { enqueueReminders } from '../outbox/enqueue';

const HOUR_MS = 60 * 60 * 1000;
export const REMINDER_EARLIEST_MS = 24 * HOUR_MS;
export const REMINDER_LATEST_MS = 2 * HOUR_MS;

/** Queues reminders for confirmed volunteers on shifts starting in (now + 2 h, now + 24 h]. */
export function remindersJob(ctx: AppContext): number {
	const now = ctx.now();
	return ctx.db.transaction((tx) => {
		const rows = tx
			.select({ shiftId: signups.shiftId, userId: signups.userId })
			.from(signups)
			.innerJoin(shifts, eq(signups.shiftId, shifts.id))
			.where(
				and(
					eq(signups.status, 'confirmed'),
					eq(shifts.status, 'scheduled'),
					gt(shifts.startsAt, now + REMINDER_LATEST_MS),
					lte(shifts.startsAt, now + REMINDER_EARLIEST_MS)
				)
			)
			.all();
		const byShift = new Map<string, string[]>();
		for (const row of rows) {
			byShift.set(row.shiftId, [...(byShift.get(row.shiftId) ?? []), row.userId]);
		}
		let inserted = 0;
		for (const [shiftId, userIds] of byShift) {
			inserted += enqueueReminders(tx, now, shiftId, userIds);
		}
		ctx.logger.info({ shifts: byShift.size, inserted }, 'reminders queued');
		return inserted;
	}, IMMEDIATE);
}
