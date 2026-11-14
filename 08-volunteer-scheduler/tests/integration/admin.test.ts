import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outbox, type OutboxRow } from '../../src/lib/server/db/schema';
import { enqueueSignupNotice } from '../../src/lib/server/outbox/enqueue';
import * as jobsPage from '../../src/routes/admin/jobs/+page.server';
import * as outboxPage from '../../src/routes/admin/outbox/+page.server';
import { createTestContext, type TestContext } from '../support/context';
import { fakeEvent, failureOf, httpStatus, thrown } from '../support/events';
import { createShiftRow, createSignupRow, createUser } from '../support/factories';

let ctx: TestContext;

beforeEach(() => {
	ctx = createTestContext(Date.UTC(2026, 0, 5, 13));
});

afterEach(() => ctx.close());

function notification(status: OutboxRow['status'], attempts: number): OutboxRow {
	const shift = createShiftRow(ctx);
	const signup = createSignupRow(ctx, shift.id, createUser(ctx).id);
	enqueueSignupNotice(ctx.db, ctx.now(), 'signup-confirmed', signup);
	return ctx.db
		.update(outbox)
		.set({ status, attempts, nextAttemptAt: 0, lastError: 'TransientProviderError: down' })
		.where(eq(outbox.userId, signup.userId))
		.returning()
		.get();
}

describe('retrying dead notifications', () => {
	it('requeues a dead row with its attempts reset', async () => {
		const admin = createUser(ctx, { role: 'admin' });
		const dead = notification('dead', 5);
		const { event } = fakeEvent({ ctx, user: admin, form: { id: dead.id } });
		expect(failureOf(await outboxPage.actions.retry(event))).toBeNull();
		const row = ctx.db.select().from(outbox).where(eq(outbox.id, dead.id)).get();
		expect(row).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: ctx.now() });
		expect(row?.dedupeKey).toBe(dead.dedupeKey);
	});

	it('refuses rows that are not dead', async () => {
		const admin = createUser(ctx, { role: 'admin' });
		const failed = notification('failed', 1);
		const { event } = fakeEvent({ ctx, user: admin, form: { id: failed.id } });
		expect(failureOf(await outboxPage.actions.retry(event))).toEqual({
			status: 409,
			code: 'not_dead'
		});
	});

	it('is limited to admins', async () => {
		const coordinator = createUser(ctx, { role: 'coordinator' });
		const dead = notification('dead', 5);
		const { event } = fakeEvent({ ctx, user: coordinator, form: { id: dead.id } });
		expect(httpStatus(await thrown(() => outboxPage.actions.retry(event)))).toBe(403);
		const row = ctx.db.select().from(outbox).where(eq(outbox.id, dead.id)).get();
		expect(row?.status).toBe('dead');
	});
});

describe('admin pages', () => {
	it('are hidden from coordinators', async () => {
		const coordinator = createUser(ctx, { role: 'coordinator' });
		for (const load of [outboxPage.load, jobsPage.load] as ((event: never) => unknown)[]) {
			const { event } = fakeEvent({ ctx, user: coordinator });
			expect(httpStatus(await thrown(() => load(event)))).toBe(403);
		}
	});

	it('list jobs and notifications for admins', async () => {
		const admin = createUser(ctx, { role: 'admin' });
		notification('dead', 5);
		const outboxData = (await outboxPage.load(
			fakeEvent({ ctx, user: admin, url: 'http://localhost/admin/outbox?status=dead' }).event
		)) as { rows: unknown[]; counts: Record<string, number> };
		expect(outboxData.rows).toHaveLength(1);
		expect(outboxData.counts.dead).toBe(1);
		const jobsData = (await jobsPage.load(fakeEvent({ ctx, user: admin }).event)) as {
			jobs: { name: string }[];
		};
		expect(jobsData.jobs.map((job) => job.name)).toEqual(['cleanup', 'materialize', 'reminders']);
	});
});
