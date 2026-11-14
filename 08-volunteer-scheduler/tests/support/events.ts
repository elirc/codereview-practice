import { isHttpError, isRedirect } from '@sveltejs/kit';
import type { SessionUser } from '../../src/lib/server/auth/session';
import type { UserRow } from '../../src/lib/server/db/schema';
import type { TestContext } from './context';

export interface EventInit {
	ctx: TestContext;
	user?: UserRow | SessionUser | null;
	form?: Record<string, string | string[]> | FormData;
	params?: Record<string, string>;
	url?: string;
	method?: string;
	cookies?: Record<string, string>;
}

export interface FakeEvent {
	/** Typed as `never` so it can be passed to any route's load, action or handler. */
	event: never;
	cookies: Map<string, string>;
}

function toSessionUser(user: UserRow | SessionUser): SessionUser {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		phone: user.phone,
		emailOptIn: user.emailOptIn,
		smsOptIn: user.smsOptIn
	};
}

/** A minimal RequestEvent for invoking loads, actions and endpoints directly. */
export function fakeEvent(init: EventInit): FakeEvent {
	const url = new URL(init.url ?? 'http://localhost/');
	let body: FormData | undefined;
	if (init.form instanceof FormData) body = init.form;
	else if (init.form) {
		body = new FormData();
		for (const [key, value] of Object.entries(init.form)) {
			for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
		}
	}
	const method = init.method ?? (body ? 'POST' : 'GET');
	const request = new Request(url, { method, body });
	const jar = new Map(Object.entries(init.cookies ?? {}));
	const cookies = {
		get: (name: string) => jar.get(name),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string) => void jar.set(name, value),
		delete: (name: string) => void jar.delete(name),
		serialize: (name: string, value: string) => `${name}=${value}`
	};
	const event = {
		request,
		url,
		params: init.params ?? {},
		cookies,
		locals: {
			requestId: 'test-request',
			log: init.ctx.logger,
			ctx: init.ctx,
			user: init.user ? toSessionUser(init.user) : null,
			session: { secure: false, ttlMs: 14 * 24 * 60 * 60 * 1000 }
		},
		route: { id: null },
		setHeaders: () => undefined,
		getClientAddress: () => '127.0.0.1',
		isDataRequest: false,
		isSubRequest: false,
		platform: undefined,
		fetch
	};
	return { event: event as never, cookies: jar };
}

/** Runs a load/action/handler and returns what it threw, failing if it did not throw. */
export async function thrown(work: () => unknown): Promise<unknown> {
	try {
		await work();
	} catch (err) {
		return err;
	}
	throw new Error('expected the call to throw');
}

export function httpStatus(err: unknown): number | undefined {
	if (isHttpError(err)) return err.status;
	if (isRedirect(err)) return err.status;
	return undefined;
}

export function redirectLocation(err: unknown): string | undefined {
	return isRedirect(err) ? err.location : undefined;
}

/** Narrows a form action result to its failure payload. */
export function failureOf(result: unknown): { status: number; code: string } | null {
	if (result && typeof result === 'object' && 'status' in result && 'data' in result) {
		const { status, data } = result as { status: number; data: { error?: { code: string } } };
		if (data?.error) return { status, code: data.error.code };
	}
	return null;
}
