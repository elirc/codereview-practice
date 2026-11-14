import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wallTimeToInstant } from '../../src/lib/domain/time';
import { createInvite } from '../../src/lib/server/auth/invite';
import { createSession } from '../../src/lib/server/auth/session';
import {
	inviteTokens,
	jobs,
	outbox,
	sessions,
	shiftSeries,
	shifts,
	type JobRow
} from '../../src/lib/server/db/schema';
import { cleanupJob, OUTBOX_RETENTION_MS } from '../../src/lib/server/jobs/cleanup';
import { jobHandlers } from '../../src/lib/server/jobs/handlers';
import { remindersJob } from '../../src/lib/server/jobs/reminders';
import {
	claimJob,
	JOB_LOCK_MS,
	runDueJobs,
	type JobHandlers
} from '../../src/lib/server/jobs/runner';
import { enqueueSignupNotice } from '../../src/lib/server/outbox/enqueue';
import { createSeries, type SeriesInput } from '../../src/lib/server/services/series';
import {
	createTestContext,
	DAY,
	HOUR,
	MINUTE,
	reopen,
	TEST_ZONE,
	type TestContext
} from '../support/context';
import { createShiftRow, createSignupRow, createUser } from '../support/factories';

let ctx: TestContext;

beforeEach(() => {
	ctx = createTestContext(wallTimeToInstant('2026-01-05', '08:00', TEST_ZONE));
});

afterEach(() => ctx.close());

function job(name: string): JobRow {
	const row = ctx.db.select().from(jobs).where(eq(jobs.name, name)).get();
	if (!row) throw new Error(`missing job ${name}`);
	return row;
}

function setJob(name: string, values: Partial<JobRow>) {
	ctx.db.update(jobs).set(values).where(eq(jobs.name, name)).run();
}

function noop(): JobHandlers {
	return { materialize: vi.fn(), reminders: vi.fn(), cleanup: vi.fn() };
}

describe('job runner', () => {
	it('runs due jobs, releases the lock and schedules the next run', async () => {
		const handlers = noop();
		const outcomes = await runDueJobs(ctx, handlers);
		expect(outcomes).toEqual({
			cleanup: 'succeeded',
			materialize: 'succeeded',
			reminders: 'succeeded'
		});
		expect(handlers.reminders).toHaveBeenCalledTimes(1);
		expect(job('reminders')).toMatchObject({
			lockedAt: null,
			lastStartedAt: ctx.now(),
			lastFinishedAt: ctx.now(),
			lastStatus: 'succeeded',
			consecutiveFailures: 0,
			nextRunAt: ctx.now() + 300_000
		});
		expect(await runDueJobs(ctx, handlers)).toEqual({});
	});

	it('leaves jobs that are not due or are locked by a live worker', async () => {
		setJob('reminders', { nextRunAt: ctx.now() + 1 });
		setJob('cleanup', { lockedAt: ctx.now() - JOB_LOCK_MS });
		const handlers = noop();
		expect(Object.keys(await runDueJobs(ctx, handlers))).toEqual(['materialize']);
		expect(handlers.cleanup).not.toHaveBeenCalled();
	});

	it('takes over a lock left by a crashed worker after ten minutes', async () => {
		setJob('cleanup', { lockedAt: ctx.now() - JOB_LOCK_MS - 1 });
		const handlers = noop();
		const outcomes = await runDueJobs(ctx, handlers);
		expect(outcomes.cleanup).toBe('succeeded');
		expect(job('cleanup').lockedAt).toBeNull();
	});

	it('backs off after repeated failures up to the interval and resets on success', async () => {
		const handlers = noop();
		let fail = true;
		handlers.reminders = () => {
			if (fail) throw new Error('database exploded');
		};
		const delays: number[] = [];
		for (let i = 0; i < 3; i++) {
			const before = ctx.now();
			await runDueJobs(ctx, handlers);
			const row = job('reminders');
			delays.push((row.nextRunAt - before) / 1000);
			expect(row).toMatchObject({ lastStatus: 'failed', lastError: 'database exploded' });
			ctx.setNow(row.nextRunAt);
		}
		expect(delays).toEqual([120, 240, 300]);
		expect(job('reminders').consecutiveFailures).toBe(3);

		fail = false;
		await runDueJobs(ctx, handlers);
		expect(job('reminders')).toMatchObject({
			lastStatus: 'succeeded',
			consecutiveFailures: 0,
			lastError: null,
			nextRunAt: ctx.now() + 300_000
		});
	});

	it('keeps running the other jobs when one handler throws', async () => {
		const handlers = noop();
		handlers.materialize = () => {
			throw new Error('boom');
		};
		const outcomes = await runDueJobs(ctx, handlers);
		expect(outcomes).toEqual({
			cleanup: 'succeeded',
			materialize: 'failed',
			reminders: 'succeeded'
		});
	});

	it('records a job without a handler as failed', async () => {
		const outcomes = await runDueJobs(ctx, { materialize: vi.fn(), reminders: vi.fn() });
		expect(outcomes.cleanup).toBe('failed');
		expect(job('cleanup').lastError).toContain('No handler');
	});

	it('lets only one worker claim a job', () => {
		const other = reopen(ctx);
		try {
			expect(claimJob(ctx, 'cleanup')).toBeDefined();
			expect(claimJob(other, 'cleanup')).toBeUndefined();
		} finally {
			other.close();
		}
	});
});

describe('reminders job', () => {
	function confirmedOn(startsAt: number, overrides: Parameters<typeof createUser>[1] = {}) {
		const shift = createShiftRow(ctx, { startsAt });
		const user = createUser(ctx, overrides);
		const signup = createSignupRow(ctx, shift.id, user.id, 'confirmed');
		return { shift, user, signup };
	}

	function reminders() {
		return ctx.db.select().from(outbox).where(eq(outbox.template, 'reminder-24h')).all();
	}

	it('creates one reminder per signup and channel however often it runs', () => {
		const { shift, user } = confirmedOn(ctx.now() + 20 * HOUR, {
			smsOptIn: true,
			phone: '+15550100300'
		});
		for (let run = 0; run < 6; run++) {
			remindersJob(ctx);
			ctx.advance(5 * MINUTE);
		}
		expect(
			reminders()
				.map((row) => row.dedupeKey)
				.sort()
		).toEqual([
			`reminder-24h:${shift.id}:${user.id}:email`,
			`reminder-24h:${shift.id}:${user.id}:sms`
		]);
	});

	it('covers shifts starting after two hours and up to twenty-four hours from now', () => {
		const now = ctx.now();
		const tooSoon = confirmedOn(now + 2 * HOUR);
		const justInside = confirmedOn(now + 2 * HOUR + 1);
		const edge = confirmedOn(now + 24 * HOUR);
		const tooFar = confirmedOn(now + 24 * HOUR + 1);
		remindersJob(ctx);
		const shiftIds = reminders().map((row) => JSON.parse(row.payload).shiftId);
		expect(shiftIds).toContain(justInside.shift.id);
		expect(shiftIds).toContain(edge.shift.id);
		expect(shiftIds).not.toContain(tooSoon.shift.id);
		expect(shiftIds).not.toContain(tooFar.shift.id);
	});

	it('reminds a volunteer who confirmed inside the window on the next run', () => {
		const shift = createShiftRow(ctx, { startsAt: ctx.now() + 10 * HOUR });
		remindersJob(ctx);
		const late = createUser(ctx);
		createSignupRow(ctx, shift.id, late.id, 'confirmed');
		ctx.advance(5 * MINUTE);
		remindersJob(ctx);
		expect(reminders().map((row) => row.userId)).toEqual([late.id]);
	});

	it('sends nothing to a volunteer confirmed two hours or less before the start', () => {
		const shift = createShiftRow(ctx, { startsAt: ctx.now() + 2 * HOUR });
		createSignupRow(ctx, shift.id, createUser(ctx).id, 'confirmed');
		remindersJob(ctx);
		ctx.advance(5 * MINUTE);
		remindersJob(ctx);
		expect(reminders()).toHaveLength(0);
	});

	it('ignores waitlisted signups and cancelled shifts', () => {
		const shift = createShiftRow(ctx, { startsAt: ctx.now() + 10 * HOUR });
		createSignupRow(ctx, shift.id, createUser(ctx).id, 'waitlisted', 1);
		const cancelled = createShiftRow(ctx, { startsAt: ctx.now() + 10 * HOUR, status: 'cancelled' });
		createSignupRow(ctx, cancelled.id, createUser(ctx).id, 'confirmed');
		remindersJob(ctx);
		expect(reminders()).toHaveLength(0);
	});
});

describe('materialize job', () => {
	const series: SeriesInput = {
		title: 'Daily sort',
		location: 'Depot',
		description: '',
		startTime: '09:00',
		durationMinutes: 60,
		capacity: 2,
		freq: 'DAILY',
		interval: 1,
		byWeekday: null,
		byMonthDay: null,
		dtstart: '2026-01-05',
		until: null,
		count: null
	};

	it('tops up healthy series and records the run as failed when one series breaks', async () => {
		const healthy = createSeries(ctx, series);
		const broken = createSeries(ctx, { ...series, freq: 'WEEKLY', byWeekday: ['MO'] });
		ctx.db
			.update(shiftSeries)
			.set({ byWeekday: '{not json' })
			.where(eq(shiftSeries.id, broken.id))
			.run();
		ctx.advance(3 * DAY);

		const outcomes = await runDueJobs(ctx, jobHandlers);
		expect(outcomes.materialize).toBe('failed');
		expect(job('materialize').lastError).toContain('1 of 2 series');
		const healthyDates = ctx.db
			.select({ date: shifts.occurrenceDate })
			.from(shifts)
			.where(eq(shifts.seriesId, healthy.id))
			.all()
			.map((row) => row.date);
		expect(healthyDates).toContain('2026-03-09');
	});
});

describe('cleanup job', () => {
	it('removes expired sessions and invite tokens and keeps live ones', () => {
		const user = createUser(ctx);
		createSession(ctx, user.id, HOUR);
		const live = createSession(ctx, user.id, 30 * DAY);
		createInvite(ctx.db, user.id, ctx.now() - 8 * DAY);
		createInvite(ctx.db, user.id, ctx.now());
		ctx.advance(2 * HOUR);
		cleanupJob(ctx);
		expect(ctx.db.select({ expiresAt: sessions.expiresAt }).from(sessions).all()).toEqual([
			{ expiresAt: live.expiresAt }
		]);
		expect(ctx.db.select().from(inviteTokens).all()).toHaveLength(1);
	});

	it('removes sent and skipped notifications older than 90 days only', () => {
		const shift = createShiftRow(ctx, { startsAt: ctx.now() + 200 * DAY });
		const notice = (status: 'sent' | 'skipped' | 'dead' | 'pending') => {
			const signup = createSignupRow(ctx, shift.id, createUser(ctx).id);
			enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
			ctx.db.update(outbox).set({ status }).where(eq(outbox.userId, signup.userId)).run();
		};
		notice('sent');
		notice('skipped');
		notice('dead');
		notice('pending');
		ctx.advance(OUTBOX_RETENTION_MS + 1);
		notice('sent');
		cleanupJob(ctx);
		const kept = ctx.db.select({ status: outbox.status }).from(outbox).all();
		expect(kept.map((row) => row.status).sort()).toEqual(['dead', 'pending', 'sent']);
	});
});
