import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { outbox, users, type OutboxStatus } from '../db/schema';
import { DomainError, notFound } from '../errors';

export function listOutbox(ctx: AppContext, status: OutboxStatus | undefined, limit = 200) {
	return ctx.db
		.select({ row: outbox, email: users.email })
		.from(outbox)
		.innerJoin(users, eq(outbox.userId, users.id))
		.where(status ? eq(outbox.status, status) : undefined)
		.orderBy(desc(outbox.createdAt), desc(outbox.id))
		.limit(limit)
		.all();
}

export function outboxCounts(ctx: AppContext): Record<string, number> {
	const rows = ctx.db
		.select({ status: outbox.status, n: sql<number>`count(*)` })
		.from(outbox)
		.groupBy(outbox.status)
		.all();
	return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

/** Puts a dead notification back in the queue for immediate delivery. */
export function retryDead(ctx: AppContext, id: string): void {
	const now = ctx.now();
	const result = ctx.db
		.update(outbox)
		.set({ status: 'pending', attempts: 0, nextAttemptAt: now, lockedAt: null })
		.where(and(eq(outbox.id, id), eq(outbox.status, 'dead')))
		.run();
	if (result.changes > 0) return;
	const exists = ctx.db.select({ id: outbox.id }).from(outbox).where(eq(outbox.id, id)).get();
	if (!exists) throw notFound('Notification not found.');
	throw new DomainError('not_dead', 409, 'Only dead notifications can be retried.');
}
