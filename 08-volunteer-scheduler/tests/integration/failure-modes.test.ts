import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wallTimeToInstant } from '../../src/lib/domain/time';
import { jobs, outbox, shifts } from '../../src/lib/server/db/schema';
import { claimJob, JOB_LOCK_MS, runDueJobs } from '../../src/lib/server/jobs/runner';
import { jobHandlers } from '../../src/lib/server/jobs/handlers';
import { claimBatch, dispatchOnce, SENDING_LOCK_MS } from '../../src/lib/server/outbox/dispatcher';
import { enqueueSignupNotice } from '../../src/lib/server/outbox/enqueue';
import { TransientProviderError } from '../../src/lib/server/outbox/providers';
import { createSeries } from '../../src/lib/server/services/series';
import { createTestContext, MINUTE, reopen, TEST_ZONE, type TestContext } from '../support/context';
import { createShiftRow, createSignupRow, createUser } from '../support/factories';
import { recordingProviders } from '../support/providers';

let ctx: TestContext;

beforeEach(() => {
	ctx = createTestContext(wallTimeToInstant('2026-01-05', '10:00', TEST_ZONE));
});

afterEach(() => ctx.close());

function queueOne() {
	const shift = createShiftRow(ctx);
	const signup = createSignupRow(ctx, shift.id, createUser(ctx).id);
	enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
	return ctx.db.select().from(outbox).get()!;
}

function capturingLogger() {
	const lines: string[] = [];
	const logger = pino({ level: 'warn' }, { write: (line: string) => void lines.push(line) });
	return { logger, lines };
}

describe('database contention', () => {
	it('treats a busy database as a skipped dispatcher tick and logs a warning', async () => {
		queueOne();
		const blocker = reopen(ctx);
		const worker = reopen(ctx);
		const { logger, lines } = capturingLogger();
		const providers = recordingProviders();
		try {
			worker.connection.sqlite.pragma('busy_timeout = 0');
			blocker.connection.sqlite.exec('BEGIN IMMEDIATE');
			const skipped = await dispatchOnce({ ctx: { ...worker, logger }, ...providers });
			expect(skipped).toEqual({ busy: true, claimed: 0, outcomes: {} });
			expect(lines.some((line) => line.includes('database busy'))).toBe(true);

			blocker.connection.sqlite.exec('ROLLBACK');
			const next = await dispatchOnce({ ctx: { ...worker, logger }, ...providers });
			expect(next.claimed).toBe(1);
			expect(providers.email.calls).toHaveLength(1);
		} finally {
			worker.close();
			blocker.close();
		}
	});
});

describe('worker crashes', () => {
	it('re-sends with the same key after a crash between sending and recording', async () => {
		const row = queueOne();
		const crashed = recordingProviders();
		const [claimed] = claimBatch(ctx);
		await crashed.email.send(
			{ to: 'x@example.org', subject: 'Confirmed', text: '...' },
			{ idempotencyKey: claimed.dedupeKey }
		);

		const survivor = reopen(ctx);
		const providers = recordingProviders();
		try {
			ctx.advance(SENDING_LOCK_MS);
			expect((await dispatchOnce({ ctx: survivor, ...providers })).claimed).toBe(0);
			ctx.advance(1);
			await dispatchOnce({ ctx: survivor, ...providers });
		} finally {
			survivor.close();
		}
		const stored = ctx.db.select().from(outbox).where(eq(outbox.id, row.id)).get();
		expect(stored).toMatchObject({ status: 'sent', attempts: 2 });
		expect(providers.email.calls.map((call) => call.options.idempotencyKey)).toEqual([
			crashed.email.calls[0].options.idempotencyKey
		]);
	});

	it('leaves a delivered row in sending when recording the result fails', async () => {
		const row = queueOne();
		ctx.connection.sqlite.exec(`
			CREATE TRIGGER block_sent BEFORE UPDATE ON outbox
			WHEN NEW.status = 'sent'
			BEGIN SELECT RAISE(ABORT, 'disk full'); END;
		`);
		const providers = recordingProviders();
		const result = await dispatchOnce({ ctx, ...providers });
		expect(result.outcomes[row.id]).toBe('lost');
		expect(providers.email.calls).toHaveLength(1);
		const stuck = ctx.db.select().from(outbox).where(eq(outbox.id, row.id)).get();
		expect(stuck).toMatchObject({ status: 'sending', attempts: 1, lastError: null });

		ctx.connection.sqlite.exec('DROP TRIGGER block_sent');
		ctx.advance(SENDING_LOCK_MS + 1);
		await dispatchOnce({ ctx, ...providers });
		const sent = ctx.db.select().from(outbox).where(eq(outbox.id, row.id)).get();
		expect(sent).toMatchObject({ status: 'sent', attempts: 2 });
		const keys = new Set(providers.email.calls.map((call) => call.options.idempotencyKey));
		expect(keys.size).toBe(1);
	});

	it('lets another worker take over a job whose runner died', async () => {
		createSeries(ctx, {
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
		});
		const before = ctx.db.select().from(shifts).all().length;
		expect(claimJob(ctx, 'materialize')).toBeDefined();

		const survivor = reopen(ctx);
		try {
			ctx.advance(JOB_LOCK_MS);
			expect((await runDueJobs(survivor, jobHandlers)).materialize).toBeUndefined();
			ctx.advance(1);
			expect((await runDueJobs(survivor, jobHandlers)).materialize).toBe('succeeded');
			expect((await runDueJobs(survivor, jobHandlers)).materialize).toBeUndefined();
		} finally {
			survivor.close();
		}
		const job = ctx.db.select().from(jobs).where(eq(jobs.name, 'materialize')).get();
		expect(job).toMatchObject({ lockedAt: null, lastStatus: 'succeeded' });
		expect(ctx.db.select().from(shifts).all().length).toBe(before);
	});
});

describe('provider outage', () => {
	it('keeps the dispatcher loop healthy while every send fails', async () => {
		queueOne();
		const providers = recordingProviders();
		providers.email.always(() => new TransientProviderError('timeout'));
		for (let tick = 0; tick < 3; tick++) {
			const result = await dispatchOnce({ ctx, ...providers });
			expect(result.busy).toBe(false);
			ctx.advance(30 * MINUTE);
		}
		const [row] = ctx.db.select().from(outbox).all();
		expect(row).toMatchObject({ status: 'pending', attempts: 3 });
	});
});
