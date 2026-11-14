import { and, inArray, lt, lte } from 'drizzle-orm';
import type { AppContext } from '../context';
import { IMMEDIATE } from '../db/client';
import { inviteTokens, outbox, sessions } from '../db/schema';

export const OUTBOX_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Removes expired sessions and invites, and sent or skipped notifications older than 90 days. */
export function cleanupJob(ctx: AppContext): void {
	const now = ctx.now();
	const removed = ctx.db.transaction((tx) => {
		const expiredSessions = tx.delete(sessions).where(lte(sessions.expiresAt, now)).run();
		const expiredInvites = tx.delete(inviteTokens).where(lte(inviteTokens.expiresAt, now)).run();
		const oldNotifications = tx
			.delete(outbox)
			.where(
				and(
					inArray(outbox.status, ['sent', 'skipped']),
					lt(outbox.createdAt, now - OUTBOX_RETENTION_MS)
				)
			)
			.run();
		return {
			sessions: expiredSessions.changes,
			invites: expiredInvites.changes,
			outbox: oldNotifications.changes
		};
	}, IMMEDIATE);
	ctx.logger.info(removed, 'cleanup finished');
}
