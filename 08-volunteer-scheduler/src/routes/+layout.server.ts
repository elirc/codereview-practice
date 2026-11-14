import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	const isPublic = url.pathname === '/login' || url.pathname.startsWith('/invite/');
	if (!locals.user && !isPublic) {
		redirect(303, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	}
	return {
		user: locals.user
			? { id: locals.user.id, name: locals.user.name, role: locals.user.role }
			: null
	};
};
