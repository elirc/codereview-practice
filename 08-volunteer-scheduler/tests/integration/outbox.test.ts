import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wallTimeToInstant } from '../../src/lib/domain/time';
import { outbox, shifts, signups, users, type OutboxRow } from '../../src/lib/server/db/schema';
import {
	claimBatch,
	dispatchOnce,
	processRow,
	SENDING_LOCK_MS,
	type DispatcherDeps
} from '../../src/lib/server/outbox/dispatcher';
import {
	enqueueReminders,
	enqueueShiftCancelled,
	enqueueSignupNotice
} from '../../src/lib/server/outbox/enqueue';
import {
	PermanentProviderError,
	TransientProviderError
} from '../../src/lib/server/outbox/providers';
import {
	createTestContext,
	HOUR,
	MINUTE,
	reopen,
	TEST_ZONE,
	type TestContext
} from '../support/context';
import { createShiftRow, createSignupRow, createUser } from '../support/factories';
import {
	recordingProviders,
	type RecordingEmailProvider,
	type RecordingSmsProvider
} from '../support/providers';

let ctx: TestContext;
let email: RecordingEmailProvider;
let sms: RecordingSmsProvider;
let deps: DispatcherDeps;

const MORNING = wallTimeToInstant('2026-01-15', '10:00', TEST_ZONE);

beforeEach(() => {
	ctx = createTestContext(MORNING);
	({ email, sms } = recordingProviders());
	deps = { ctx, email, sms };
});

afterEach(() => ctx.close());

function rows(): OutboxRow[] {
	return ctx.db.select().from(outbox).all();
}

function row(id: string): OutboxRow {
	const found = ctx.db.select().from(outbox).where(eq(outbox.id, id)).get();
	if (!found) throw new Error(`no outbox row ${id}`);
	return found;
}

function confirmedSignup(userOverrides: Parameters<typeof createUser>[1] = {}) {
	const user = createUser(ctx, userOverrides);
	const shift = createShiftRow(ctx);
	const signup = createSignupRow(ctx, shift.id, user.id, 'confirmed');
	return { user, shift, signup };
}

describe('enqueueing', () => {
	it('creates one row per enabled channel and ignores repeats of the same event', () => {
		const { signup } = confirmedSignup({ smsOptIn: true, phone: '+15550100001' });
		expect(enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup)).toBe(2);
		expect(enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup)).toBe(0);
		expect(
			rows()
				.map((r) => r.dedupeKey)
				.sort()
		).toEqual([`signup-confirmed:${signup.id}:email`, `signup-confirmed:${signup.id}:sms`]);
	});

	it('follows preferences at creation time and needs a phone for sms', () => {
		const noPhone = confirmedSignup({ smsOptIn: true, phone: null });
		const noEmail = confirmedSignup({ emailOptIn: false });
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', noPhone.signup);
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', noEmail.signup);
		expect(rows().map((r) => r.channel)).toEqual(['email']);
	});

	it('keys shift-wide notices by shift and user', () => {
		const { user, shift } = confirmedSignup();
		enqueueShiftCancelled(ctx.db, ctx.now(), shift.id, [user.id, user.id]);
		enqueueShiftCancelled(ctx.db, ctx.now(), shift.id, [user.id]);
		expect(rows().map((r) => r.dedupeKey)).toEqual([
			`shift-cancelled:${shift.id}:${user.id}:email`
		]);
	});
});

describe('dispatching', () => {
	it('sends with the dedupe key as idempotency key and records the provider id', async () => {
		const { user, signup } = confirmedSignup();
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		const result = await dispatchOnce(deps);
		expect(result.claimed).toBe(1);
		expect(email.calls).toHaveLength(1);
		expect(email.calls[0].options.idempotencyKey).toBe(`signup-confirmed:${signup.id}:email`);
		expect(email.calls[0].message.to).toBe(user.email);
		expect(email.calls[0].message.text).toContain('Sun 18 Jan 2026, 10:00 EST');
		expect(rows()[0]).toMatchObject({
			status: 'sent',
			attempts: 1,
			providerMessageId: 'email-1',
			sentAt: MORNING,
			lockedAt: null
		});
		expect((await dispatchOnce(deps)).claimed).toBe(0);
	});

	it('renders from current data rather than the data at enqueue time', async () => {
		const { shift, signup } = confirmedSignup();
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		ctx.db.update(shifts).set({ title: 'Soup kitchen' }).where(eq(shifts.id, shift.id)).run();
		await dispatchOnce(deps);
		expect(email.calls[0].message.subject).toBe('Confirmed: Soup kitchen');
	});

	it('skips a confirmation whose signup is no longer confirmed', async () => {
		const { signup } = confirmedSignup();
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		ctx.db.update(signups).set({ status: 'cancelled' }).where(eq(signups.id, signup.id)).run();
		await dispatchOnce(deps);
		expect(email.calls).toHaveLength(0);
		expect(rows()[0].status).toBe('skipped');
	});

	it('skips a reminder after the volunteer cancels', async () => {
		const { user, shift, signup } = confirmedSignup();
		enqueueReminders(ctx.db, ctx.now(), shift.id, [user.id]);
		ctx.db.update(signups).set({ status: 'cancelled' }).where(eq(signups.id, signup.id)).run();
		await dispatchOnce(deps);
		expect(rows()[0].status).toBe('skipped');
	});

	it('skips a reminder that is processed after the shift started', async () => {
		const { user, shift } = confirmedSignup();
		enqueueReminders(ctx.db, ctx.now(), shift.id, [user.id]);
		ctx.setNow(shift.startsAt);
		await dispatchOnce(deps);
		expect(rows()[0].status).toBe('skipped');
		expect(email.calls).toHaveLength(0);
	});

	it('skips sms when the user opted out after the row was created', async () => {
		const { user, signup } = confirmedSignup({ smsOptIn: true, phone: '+15550100002' });
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		ctx.db.update(users).set({ smsOptIn: false }).where(eq(users.id, user.id)).run();
		await dispatchOnce(deps);
		const byChannel = Object.fromEntries(rows().map((r) => [r.channel, r.status]));
		expect(byChannel).toEqual({ email: 'sent', sms: 'skipped' });
		expect(sms.calls).toHaveLength(0);
	});

	it('skips notifications for deactivated users', async () => {
		const { user, signup } = confirmedSignup();
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		ctx.db.update(users).set({ active: false }).where(eq(users.id, user.id)).run();
		await dispatchOnce(deps);
		expect(rows()[0].status).toBe('skipped');
	});
});

describe('quiet hours', () => {
	it('defers sms at 22:00 to 08:00 without using an attempt while email goes now', async () => {
		ctx.setNow(wallTimeToInstant('2026-01-15', '22:00', TEST_ZONE));
		const { signup } = confirmedSignup({ smsOptIn: true, phone: '+15550100003' });
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		await dispatchOnce(deps);

		const byChannel = Object.fromEntries(rows().map((r) => [r.channel, r]));
		expect(byChannel.email.status).toBe('sent');
		expect(byChannel.sms).toMatchObject({
			status: 'pending',
			attempts: 0,
			lockedAt: null,
			nextAttemptAt: wallTimeToInstant('2026-01-16', '08:00', TEST_ZONE)
		});

		ctx.setNow(wallTimeToInstant('2026-01-16', '07:59', TEST_ZONE));
		expect((await dispatchOnce(deps)).claimed).toBe(0);
		ctx.setNow(wallTimeToInstant('2026-01-16', '08:00', TEST_ZONE));
		await dispatchOnce(deps);
		expect(row(byChannel.sms.id)).toMatchObject({ status: 'sent', attempts: 1 });
		expect(sms.calls).toHaveLength(1);
	});
});

describe('failures', () => {
	it('retries transient failures at 1, 5, 25 and 120 minutes, then gives up', async () => {
		const { signup } = confirmedSignup();
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		email.always(() => new TransientProviderError('provider unavailable'));
		const [only] = rows();

		const delays: number[] = [];
		for (let attempt = 1; attempt <= 4; attempt++) {
			const before = ctx.now();
			await dispatchOnce(deps);
			const current = row(only.id);
			expect(current).toMatchObject({ status: 'pending', attempts: attempt });
			delays.push(current.nextAttemptAt - before);
			ctx.setNow(current.nextAttemptAt - 1);
			expect((await dispatchOnce(deps)).claimed).toBe(0);
			ctx.setNow(current.nextAttemptAt);
		}
		expect(delays).toEqual([1, 5, 25, 120].map((m) => m * MINUTE));

		await dispatchOnce(deps);
		expect(row(only.id)).toMatchObject({ status: 'dead', attempts: 5 });
		expect(row(only.id).lastError).toContain('provider unavailable');
		expect(email.calls).toHaveLength(5);
		expect(new Set(email.calls.map((c) => c.options.idempotencyKey))).toEqual(
			new Set([only.dedupeKey])
		);
	});

	it('treats unexpected errors like transient ones', async () => {
		const { signup } = confirmedSignup();
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		email.queue(new Error('socket hang up'));
		await dispatchOnce(deps);
		expect(rows()[0]).toMatchObject({ status: 'pending', attempts: 1 });
	});

	it('fails permanently rejected messages after one attempt', async () => {
		const { signup } = confirmedSignup({
			smsOptIn: true,
			phone: '+15550100004',
			emailOptIn: false
		});
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		sms.queue(new PermanentProviderError('invalid number'));
		await dispatchOnce(deps);
		expect(rows()[0]).toMatchObject({ status: 'failed', attempts: 1 });
		ctx.advance(3 * HOUR);
		await dispatchOnce(deps);
		expect(sms.calls).toHaveLength(1);
	});

	it('marks a corrupt payload failed and still sends the rest of the batch', async () => {
		const first = confirmedSignup();
		const second = confirmedSignup();
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', first.signup);
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', second.signup);
		const [broken] = rows();
		ctx.db
			.update(outbox)
			.set({ payload: '{"signupId":' })
			.where(eq(outbox.id, broken.id))
			.run();
		const unknown = { ...broken, id: randomUUID(), dedupeKey: 'mystery:1:email' };
		ctx.db.insert(outbox).values({ ...unknown, template: 'mystery', payload: '{}' }).run();

		const result = await dispatchOnce(deps);
		expect(result.claimed).toBe(3);
		const statuses = rows().map((r) => [r.dedupeKey, r.status, r.lastError !== null]);
		expect(statuses).toContainEqual([broken.dedupeKey, 'failed', true]);
		expect(statuses).toContainEqual(['mystery:1:email', 'failed', true]);
		expect(email.calls).toHaveLength(1);
	});
});

describe('locks', () => {
	it('requeues a row abandoned mid-send once its lock expires', async () => {
		const { signup } = confirmedSignup();
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		const [claimed] = claimBatch(ctx);
		expect(claimed.attempts).toBe(1);

		ctx.advance(SENDING_LOCK_MS);
		expect(claimBatch(ctx)).toHaveLength(0);
		expect(row(claimed.id)).toMatchObject({ status: 'sending', attempts: 1 });

		ctx.advance(1);
		await dispatchOnce(deps);
		expect(row(claimed.id)).toMatchObject({ status: 'sent', attempts: 2 });
		expect(email.calls[0].options.idempotencyKey).toBe(claimed.dedupeKey);
	});

	it('never hands the same row to two connections within a lock window', () => {
		for (let i = 0; i < 30; i++) {
			const { signup } = confirmedSignup();
			enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		}
		const other = reopen(ctx);
		try {
			const a = claimBatch(ctx);
			const b = claimBatch(other);
			const c = claimBatch(ctx);
			expect(a).toHaveLength(20);
			expect(b).toHaveLength(10);
			expect(c).toHaveLength(0);
			const ids = [...a, ...b].map((r) => r.id);
			expect(new Set(ids).size).toBe(30);
		} finally {
			other.close();
		}
	});

	it('does not overwrite a row that another worker reclaimed', async () => {
		const { signup } = confirmedSignup();
		enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
		const [claimed] = claimBatch(ctx);
		ctx.db.update(outbox).set({ status: 'sent' }).where(eq(outbox.id, claimed.id)).run();
		expect(await processRow(deps, claimed)).toBe('lost');
	});
});
