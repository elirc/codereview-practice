import { redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { authenticate } from '$lib/server/auth/credentials';
import { createSession, SESSION_COOKIE, sessionCookieOptions } from '$lib/server/auth/session';
import { DomainError } from '$lib/server/errors';
import { actionFailure, parseForm } from '$lib/server/forms';
import type { Actions, PageServerLoad } from './$types';

const loginSchema = z.object({
	email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
	password: z.string().min(1, 'Enter your password.').max(200),
	next: z.string().optional()
});

/** Only same-site relative paths are followed after login. */
function safeNext(next: string | undefined): string {
	if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) {
		return next;
	}
	return '/';
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) redirect(303, '/');
	return { next: url.searchParams.get('next') ?? '' };
};

export const actions: Actions = {
	default: async (event) => {
		const parsed = await parseForm(event, loginSchema);
		if (!parsed.ok) return parsed.failure;
		const { ctx, session } = event.locals;
		const user = await authenticate(ctx, parsed.data.email, parsed.data.password);
		if (!user) {
			return actionFailure(
				event,
				new DomainError('invalid_credentials', 401, 'Email or password is incorrect.'),
				parsed.values
			);
		}
		const created = createSession(ctx, user.id, session.ttlMs);
		event.cookies.set(
			SESSION_COOKIE,
			created.token,
			sessionCookieOptions(session, created.expiresAt)
		);
		event.locals.log.info({ userId: user.id }, 'user signed in');
		redirect(303, safeNext(parsed.data.next));
	}
};
