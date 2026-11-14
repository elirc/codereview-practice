import { and, asc, eq, isNull, lt, lte, or } from 'drizzle-orm';
import type { AppContext } from '../context';
import { IMMEDIATE } from '../db/client';
import { jobs, type JobRow } from '../db/schema';

export type JobHandler = (ctx: AppContext) => unknown;
export type JobHandlers = Record<string, JobHandler>;
export type JobOutcome = 'succeeded' | 'failed';

export const JOB_LOCK_MS = 10 * 60_000;

function claimable(now: number) {
	return and(
		lte(jobs.nextRunAt, now),
		or(isNull(jobs.lockedAt), lt(jobs.lockedAt, now - JOB_LOCK_MS))
	);
}

/** Seconds to wait after a failure, doubling with each consecutive failure up to the interval. */
export function failureDelaySeconds(intervalSeconds: number, consecutiveFailures: number): number {
	return Math.min(intervalSeconds, 60 * 2 ** consecutiveFailures);
}

/** Locks a due job for this worker; undefined if it is not due or another worker holds it. */
export function claimJob(ctx: AppContext, name: string): JobRow | undefined {
	const now = ctx.now();
	return ctx.db.transaction(
		(tx) =>
			tx
				.update(jobs)
				.set({ lockedAt: now, lastStartedAt: now })
				.where(and(eq(jobs.name, name), claimable(now)))
				.returning()
				.get(),
		IMMEDIATE
	);
}

function errorMessage(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

/** Runs a claimed job and records the result, releasing the lock. */
export async function runClaimedJob(
	ctx: AppContext,
	job: JobRow,
	handler: JobHandler | undefined
): Promise<JobOutcome> {
	const attempt = job.consecutiveFailures + 1;
	const log = ctx.logger.child({ job: job.name, startedAt: job.lockedAt, attempt });
	const ownLock = and(eq(jobs.name, job.name), eq(jobs.lockedAt, job.lockedAt ?? -1));
	log.info('job started');
	try {
		if (!handler) throw new Error(`No handler is registered for job ${job.name}.`);
		await handler(ctx);
		const finished = ctx.now();
		ctx.db
			.update(jobs)
			.set({
				lockedAt: null,
				lastFinishedAt: finished,
				lastStatus: 'succeeded',
				lastError: null,
				consecutiveFailures: 0,
				nextRunAt: finished + job.intervalSeconds * 1000
			})
			.where(ownLock)
			.run();
		log.info('job finished');
		return 'succeeded';
	} catch (err) {
		const finished = ctx.now();
		const failures = job.consecutiveFailures + 1;
		const delay = failureDelaySeconds(job.intervalSeconds, failures);
		ctx.db
			.update(jobs)
			.set({
				lockedAt: null,
				lastFinishedAt: finished,
				lastStatus: 'failed',
				lastError: errorMessage(err),
				consecutiveFailures: failures,
				nextRunAt: finished + delay * 1000
			})
			.where(ownLock)
			.run();
		log.error({ err, retryInSeconds: delay }, 'job failed');
		return 'failed';
	}
}

/** One scheduler tick: claims and runs every due job in turn. */
export async function runDueJobs(
	ctx: AppContext,
	handlers: JobHandlers
): Promise<Record<string, JobOutcome>> {
	const due = ctx.db
		.select({ name: jobs.name })
		.from(jobs)
		.where(claimable(ctx.now()))
		.orderBy(asc(jobs.nextRunAt), asc(jobs.name))
		.all();
	const outcomes: Record<string, JobOutcome> = {};
	for (const { name } of due) {
		const claimed = claimJob(ctx, name);
		if (!claimed) continue;
		outcomes[name] = await runClaimedJob(ctx, claimed, handlers[name]);
	}
	return outcomes;
}

export function listJobs(ctx: AppContext): JobRow[] {
	return ctx.db.select().from(jobs).orderBy(asc(jobs.name)).all();
}
