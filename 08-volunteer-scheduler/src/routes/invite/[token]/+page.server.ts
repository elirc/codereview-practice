import { redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { acceptInvite, findInvite } from '$lib/server/auth/invite';
import { hashPassword } from '$lib/server/auth/password';
import { createSession, SESSION_COOKIE, sessionCookieOptions } from '$lib/server/auth/session';
import { attempt, parseForm } from '$lib/server/forms';
import type { Actions, PageServerLoad } from './$types';

const passwordSchema = z
	.object({
		password: z.string().min(10, 'Use at least 10 characters.').max(200),
		passwordConfirm: z.string()
	})
	.refine((value) => value.password === value.passwordConfirm, {
		message: 'Passwords do not match.',
		path: ['passwordConfirm']
	});

export const load: PageServerLoad = ({ locals, params }) => {
	const invite = findInvite(locals.ctx, params.token);
	return { invite: invite ? { name: invite.name, email: invite.email } : null };
};

export const actions: Actions = {
	default: async (event) => {
		const parsed = await parseForm(event, passwordSchema);
		if (!parsed.ok) return parsed.failure;
		const passwordHash = await hashPassword(parsed.data.password);
		const { ctx, session } = event.locals;
		const result = attempt(event, parsed.values, () =>
			acceptInvite(ctx, event.params.token, passwordHash)
		);
		if (!result.ok) return result.failure;
		const created = createSession(ctx, result.value, session.ttlMs);
		event.cookies.set(
			SESSION_COOKIE,
			created.token,
			sessionCookieOptions(session, created.expiresAt)
		);
		redirect(303, '/');
	}
};
