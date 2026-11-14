import { requireRole } from '$lib/server/auth/guard';
import { listJobs } from '$lib/server/jobs/runner';
import { timestampLabel } from '$lib/server/view';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireRole(event, 'admin');
	const { ctx } = event.locals;
	const now = ctx.now();
	return {
		jobs: listJobs(ctx).map((job) => ({
			name: job.name,
			intervalSeconds: job.intervalSeconds,
			nextRunAt: timestampLabel(job.nextRunAt, ctx.zone),
			due: job.nextRunAt <= now,
			locked: job.lockedAt !== null,
			lockedAt: timestampLabel(job.lockedAt, ctx.zone),
			lastStartedAt: timestampLabel(job.lastStartedAt, ctx.zone),
			lastFinishedAt: timestampLabel(job.lastFinishedAt, ctx.zone),
			lastStatus: job.lastStatus ?? '',
			lastError: job.lastError ?? '',
			consecutiveFailures: job.consecutiveFailures
		}))
	};
};
