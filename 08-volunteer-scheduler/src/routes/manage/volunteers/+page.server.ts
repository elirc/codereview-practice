import { z } from 'zod';
import { requireManager } from '$lib/server/auth/guard';
import { ROLES } from '$lib/server/db/schema';
import { listUsers } from '$lib/server/services/users';
import type { PageServerLoad } from './$types';

const filterSchema = z.object({
	q: z.string().trim().max(100).catch(''),
	role: z.enum(ROLES).optional().catch(undefined)
});

export const load: PageServerLoad = (event) => {
	requireManager(event);
	const filter = filterSchema.parse({
		q: event.url.searchParams.get('q') ?? '',
		role: event.url.searchParams.get('role') || undefined
	});
	const people = listUsers(event.locals.ctx, { q: filter.q || undefined, role: filter.role });
	return {
		filter: { q: filter.q, role: filter.role ?? '' },
		volunteers: people.map((user) => ({
			id: user.id,
			name: user.name,
			email: user.email,
			phone: user.phone ?? '',
			role: user.role,
			active: user.active,
			notifications:
				[user.emailOptIn ? 'email' : '', user.smsOptIn ? 'sms' : ''].filter(Boolean).join(', ') ||
				'none',
			invitePending: user.passwordHash === null
		}))
	};
};
