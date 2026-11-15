import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wallTimeToInstant } from '../../src/lib/domain/time';
import { shifts, signups, type UserRow } from '../../src/lib/server/db/schema';
import { createShift } from '../../src/lib/server/services/shifts';
import { signUp } from '../../src/lib/server/services/signups';
import * as home from '../../src/routes/+page.server';
import * as my from '../../src/routes/my/+page.server';
import * as series from '../../src/routes/manage/series/[id]/+page.server';
import * as newSeries from '../../src/routes/manage/series/new/+page.server';
import * as shiftList from '../../src/routes/manage/shifts/+page.server';
import * as shiftDetail from '../../src/routes/manage/shifts/[id]/+page.server';
import { createTestContext, TEST_ZONE, type TestContext } from '../support/context';
import { fakeEvent, failureOf, httpStatus, thrown } from '../support/events';
import { createUser } from '../support/factories';

let ctx: TestContext;
let volunteer: UserRow;
let shiftId: string;

beforeEach(() => {
	ctx = createTestContext(wallTimeToInstant('2026-01-05', '08:00', TEST_ZONE));
	volunteer = createUser(ctx);
	shiftId = createShift(ctx, {
		title: 'Pantry',
		location: 'Hall',
		date: '2026-01-10',
		startTime: '09:00',
		durationMinutes: 120,
		capacity: 2
	}).id;
});

afterEach(() => ctx.close());

type Handler = (event: never) => unknown;

const managerActions: [string, Handler, Record<string, string>][] = [
	['create shift', shiftList.actions.create, { title: 'X', location: 'Y' }],
	['edit shift', shiftDetail.actions.update, { title: 'Changed' }],
	['cancel shift', shiftDetail.actions.cancel, {}],
	['add to roster', shiftDetail.actions.add, { email: 'someone@example.org' }],
	['remove from roster', shiftDetail.actions.remove, { signupId: randomUUID() }],
	['mark attendance', shiftDetail.actions.attendance, { signupId: randomUUID() }],
	['create series', newSeries.actions.default, { title: 'Series' }],
	['edit series', series.actions.update, { title: 'Series' }],
	['add exception', series.actions.exception, { occurrenceDate: '2026-01-10' }],
	['delete series', series.actions.delete, {}]
];

describe('manager form actions', () => {
	it.each(managerActions)('refuse a volunteer posting %s directly', async (_, action, form) => {
		const { event } = fakeEvent({ ctx, user: volunteer, params: { id: shiftId }, form });
		expect(httpStatus(await thrown(() => action(event)))).toBe(403);
	});

	it.each(managerActions)('require a session for %s', async (_, action, form) => {
		const { event } = fakeEvent({ ctx, user: null, params: { id: shiftId }, form });
		expect(httpStatus(await thrown(() => action(event)))).toBe(401);
	});

	it('leave the shift untouched after a refused cancel', async () => {
		const { event } = fakeEvent({ ctx, user: volunteer, params: { id: shiftId }, form: {} });
		await thrown(() => shiftDetail.actions.cancel(event));
		const stored = ctx.db.select().from(shifts).where(eq(shifts.id, shiftId)).get();
		expect(stored?.status).toBe('scheduled');
	});
});

describe('manager pages', () => {
	it.each([
		['shift list', shiftList.load],
		['shift detail', shiftDetail.load],
		['series detail', series.load],
		['new series', newSeries.load]
	] as [string, Handler][])('refuse to load the %s for a volunteer', async (_, load) => {
		const { event } = fakeEvent({ ctx, user: volunteer, params: { id: shiftId } });
		expect(httpStatus(await thrown(() => load(event)))).toBe(403);
	});
});

describe('signups belonging to someone else', () => {
	it.each([
		['home page', home.actions.cancel],
		['my signups', my.actions.cancel]
	] as [string, Handler][])('are reported as not found from the %s', async (_, action) => {
		const owner = createUser(ctx);
		const signup = signUp(ctx, { userId: owner.id, shiftId, actor: owner });
		const { event } = fakeEvent({ ctx, user: volunteer, form: { signupId: signup.id } });
		expect(failureOf(await action(event))).toEqual({ status: 404, code: 'not_found' });
		const stored = ctx.db.select().from(signups).where(eq(signups.id, signup.id)).get();
		expect(stored?.status).toBe('confirmed');
	});

	it('can still be cancelled by their owner', async () => {
		const signup = signUp(ctx, { userId: volunteer.id, shiftId, actor: volunteer });
		const { event } = fakeEvent({ ctx, user: volunteer, form: { signupId: signup.id } });
		expect(failureOf(await home.actions.cancel(event))).toBeNull();
	});

	it('can be removed by a coordinator from the home page', async () => {
		const coordinator = createUser(ctx, { role: 'coordinator' });
		const signup = signUp(ctx, { userId: volunteer.id, shiftId, actor: volunteer });
		const { event } = fakeEvent({
			ctx,
			user: coordinator,
			form: { signupId: signup.id, shiftId }
		});
		expect(await home.actions.cancel(event)).toEqual({ notice: 'Volunteer removed.' });
		const stored = ctx.db.select().from(signups).where(eq(signups.id, signup.id)).get();
		expect(stored?.status).toBe('cancelled');
	});
});

describe('volunteer sign-up action', () => {
	it('signs the current user up', async () => {
		const { event } = fakeEvent({ ctx, user: volunteer, form: { shiftId } });
		expect(failureOf(await home.actions.signup(event))).toBeNull();
		const rows = ctx.db.select().from(signups).where(eq(signups.userId, volunteer.id)).all();
		expect(rows.map((row) => row.status)).toEqual(['confirmed']);
	});

	it('rejects a malformed shift id', async () => {
		const { event } = fakeEvent({ ctx, user: volunteer, form: { shiftId: 'nope' } });
		expect(failureOf(await home.actions.signup(event))?.code).toBe('validation_failed');
	});
});
