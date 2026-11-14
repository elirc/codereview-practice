import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createInvite, findInvite, INVITE_TTL_MS } from '../../src/lib/server/auth/invite';
import { hashPassword } from '../../src/lib/server/auth/password';
import { createSession, findSessionUser, SESSION_COOKIE } from '../../src/lib/server/auth/session';
import { sessions, users } from '../../src/lib/server/db/schema';
import { actions as userActions } from '../../src/routes/admin/users/+page.server';
import { actions as inviteActions } from '../../src/routes/invite/[token]/+page.server';
import { actions as loginActions } from '../../src/routes/login/+page.server';
import { createTestContext, DAY, type TestContext } from '../support/context';
import { fakeEvent, failureOf, httpStatus, redirectLocation, thrown } from '../support/events';
import { createUser } from '../support/factories';

let ctx: TestContext;
let passwordHash: string;
const PASSWORD = 'correct horse battery';

beforeAll(async () => {
	passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
	ctx = createTestContext(Date.UTC(2026, 2, 2, 15));
});

afterEach(() => ctx.close());

describe('login', () => {
	it('starts a session and redirects to the requested page', async () => {
		const user = createUser(ctx, { email: 'vol@example.org', passwordHash });
		const { event, cookies } = fakeEvent({
			ctx,
			form: { email: 'VOL@example.org', password: PASSWORD, next: '/my' }
		});
		const err = await thrown(() => loginActions.default(event));
		expect(redirectLocation(err)).toBe('/my');
		const token = cookies.get(SESSION_COOKIE);
		expect(token).toBeDefined();
		expect(findSessionUser(ctx, token!)?.id).toBe(user.id);
		const stored = ctx.db.select().from(sessions).all();
		expect(stored).toHaveLength(1);
		expect(stored[0].tokenHash).not.toBe(token);
	});

	it('ignores off-site redirect targets', async () => {
		createUser(ctx, { email: 'vol@example.org', passwordHash });
		const { event } = fakeEvent({
			ctx,
			form: { email: 'vol@example.org', password: PASSWORD, next: '//evil.example' }
		});
		expect(redirectLocation(await thrown(() => loginActions.default(event)))).toBe('/');
	});

	it('rejects a wrong password and an inactive account alike', async () => {
		createUser(ctx, { email: 'vol@example.org', passwordHash });
		createUser(ctx, { email: 'gone@example.org', passwordHash, active: false });
		for (const form of [
			{ email: 'vol@example.org', password: 'wrong password' },
			{ email: 'gone@example.org', password: PASSWORD },
			{ email: 'nobody@example.org', password: PASSWORD }
		]) {
			const { event, cookies } = fakeEvent({ ctx, form });
			expect(failureOf(await loginActions.default(event))).toEqual({
				status: 401,
				code: 'invalid_credentials'
			});
			expect(cookies.has(SESSION_COOKIE)).toBe(false);
		}
	});

	it('rejects malformed input with field errors', async () => {
		const { event } = fakeEvent({ ctx, form: { email: 'not-an-email', password: '' } });
		expect(failureOf(await loginActions.default(event))).toEqual({
			status: 400,
			code: 'validation_failed'
		});
	});
});

describe('sessions', () => {
	it('expire after their lifetime', () => {
		const user = createUser(ctx);
		const { token } = createSession(ctx, user.id, 1_000);
		ctx.advance(999);
		expect(findSessionUser(ctx, token)).not.toBeNull();
		ctx.advance(1);
		expect(findSessionUser(ctx, token)).toBeNull();
	});

	it('stop working when the user is deactivated', () => {
		const user = createUser(ctx);
		const { token } = createSession(ctx, user.id, DAY);
		ctx.db.update(users).set({ active: false }).where(eq(users.id, user.id)).run();
		expect(findSessionUser(ctx, token)).toBeNull();
	});
});

describe('invites', () => {
	function invite(userId: string) {
		return createInvite(ctx.db, userId, ctx.now());
	}

	it('set a password once and cannot be reused', async () => {
		const user = createUser(ctx, { email: 'new@example.org' });
		const token = invite(user.id);
		expect(findInvite(ctx, token)?.email).toBe('new@example.org');

		const first = fakeEvent({
			ctx,
			params: { token },
			form: { password: 'a long new password', passwordConfirm: 'a long new password' }
		});
		expect(redirectLocation(await thrown(() => inviteActions.default(first.event)))).toBe('/');
		expect(first.cookies.has(SESSION_COOKIE)).toBe(true);
		const stored = ctx.db.select().from(users).where(eq(users.id, user.id)).get();
		expect(stored?.passwordHash).toMatch(/^scrypt\$/);
		expect(findInvite(ctx, token)).toBeNull();

		const second = fakeEvent({
			ctx,
			params: { token },
			form: { password: 'another password!', passwordConfirm: 'another password!' }
		});
		expect(failureOf(await inviteActions.default(second.event))).toEqual({
			status: 404,
			code: 'invite_invalid'
		});
		const after = ctx.db.select().from(users).where(eq(users.id, user.id)).get();
		expect(after?.passwordHash).toBe(stored?.passwordHash);
	});

	it('invalidate every outstanding invite for the user once a password is set', async () => {
		const user = createUser(ctx);
		const older = invite(user.id);
		const newer = invite(user.id);
		const { event } = fakeEvent({
			ctx,
			params: { token: newer },
			form: { password: 'a long new password', passwordConfirm: 'a long new password' }
		});
		await thrown(() => inviteActions.default(event));
		expect(findInvite(ctx, older)).toBeNull();
	});

	it('expire after seven days', async () => {
		const user = createUser(ctx);
		const token = invite(user.id);
		ctx.advance(INVITE_TTL_MS);
		expect(findInvite(ctx, token)).toBeNull();
		const { event } = fakeEvent({
			ctx,
			params: { token },
			form: { password: 'a long new password', passwordConfirm: 'a long new password' }
		});
		expect(failureOf(await inviteActions.default(event))?.code).toBe('invite_invalid');
	});

	it('require matching passwords', async () => {
		const user = createUser(ctx);
		const token = invite(user.id);
		const { event } = fakeEvent({
			ctx,
			params: { token },
			form: { password: 'a long new password', passwordConfirm: 'something else' }
		});
		expect(failureOf(await inviteActions.default(event))?.code).toBe('validation_failed');
		expect(findInvite(ctx, token)).not.toBeNull();
	});
});

describe('user administration', () => {
	it('is refused to coordinators', async () => {
		const coordinator = createUser(ctx, { role: 'coordinator' });
		const target = createUser(ctx);
		const { event } = fakeEvent({
			ctx,
			user: coordinator,
			form: { userId: target.id, role: 'admin' }
		});
		expect(httpStatus(await thrown(() => userActions.role(event)))).toBe(403);
		const stored = ctx.db.select().from(users).where(eq(users.id, target.id)).get();
		expect(stored?.role).toBe('volunteer');
	});

	it('changes roles and deactivates accounts, ending their sessions', async () => {
		const admin = createUser(ctx, { role: 'admin' });
		const target = createUser(ctx);
		const { token } = createSession(ctx, target.id, DAY);

		const role = fakeEvent({ ctx, user: admin, form: { userId: target.id, role: 'coordinator' } });
		expect(failureOf(await userActions.role(role.event))).toBeNull();
		const active = fakeEvent({ ctx, user: admin, form: { userId: target.id, active: 'false' } });
		expect(failureOf(await userActions.active(active.event))).toBeNull();

		const stored = ctx.db.select().from(users).where(eq(users.id, target.id)).get();
		expect(stored).toMatchObject({ role: 'coordinator', active: false });
		expect(findSessionUser(ctx, token)).toBeNull();
		expect(ctx.db.select().from(sessions).all()).toHaveLength(0);
	});

	it('does not let an admin change their own account', async () => {
		const admin = createUser(ctx, { role: 'admin' });
		const { event } = fakeEvent({
			ctx,
			user: admin,
			form: { userId: admin.id, role: 'volunteer' }
		});
		expect(failureOf(await userActions.role(event))).toEqual({
			status: 422,
			code: 'cannot_modify_self'
		});
	});
});
