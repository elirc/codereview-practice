import { redirect } from '@sveltejs/kit';
import { deleteSession, SESSION_COOKIE } from '$lib/server/auth/session';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	redirect(303, '/');
};

export const actions: Actions = {
	default: (event) => {
		const token = event.cookies.get(SESSION_COOKIE);
		if (token) deleteSession(event.locals.ctx, token);
		event.cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	}
};
