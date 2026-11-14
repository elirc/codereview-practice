import { z } from 'zod';
import { requireRole } from '$lib/server/auth/guard';
import { OUTBOX_STATUSES } from '$lib/server/db/schema';
import { attempt, parseForm } from '$lib/server/forms';
import { listOutbox, outboxCounts, retryDead } from '$lib/server/outbox/admin';
import { uuidField } from '$lib/server/schemas';
import { timestampLabel } from '$lib/server/view';
import type { Actions, PageServerLoad } from './$types';

const statusFilter = z.enum(OUTBOX_STATUSES).optional().catch(undefined);

export const load: PageServerLoad = (event) => {
	requireRole(event, 'admin');
	const { ctx } = event.locals;
	const status = statusFilter.parse(event.url.searchParams.get('status') ?? undefined);
	return {
		status: status ?? '',
		statuses: OUTBOX_STATUSES,
		counts: outboxCounts(ctx),
		rows: listOutbox(ctx, status).map(({ row, email }) => ({
			id: row.id,
			email,
			channel: row.channel,
			template: row.template,
			status: row.status,
			attempts: row.attempts,
			dedupeKey: row.dedupeKey,
			lastError: row.lastError,
			createdAt: timestampLabel(row.createdAt, ctx.zone),
			nextAttemptAt: timestampLabel(row.nextAttemptAt, ctx.zone),
			sentAt: timestampLabel(row.sentAt, ctx.zone)
		}))
	};
};

export const actions: Actions = {
	retry: async (event) => {
		requireRole(event, 'admin');
		const parsed = await parseForm(event, z.object({ id: uuidField }));
		if (!parsed.ok) return parsed.failure;
		const result = attempt(event, parsed.values, () => retryDead(event.locals.ctx, parsed.data.id));
		return result.ok ? { notice: 'Notification queued for another attempt.' } : result.failure;
	}
};
