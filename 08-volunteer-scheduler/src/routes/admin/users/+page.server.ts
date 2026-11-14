import { z } from 'zod';
import { requireRole } from '$lib/server/auth/guard';
import { ROLES } from '$lib/server/db/schema';
import { attempt, parseForm } from '$lib/server/forms';
import { issueInvite, listUsers, setUserActive, setUserRole } from '$lib/server/services/users';
import type { Actions, PageServerLoad } from './$types';

const userId = z.string().uuid();

export const load: PageServerLoad = (event) => {
	requireRole(event, 'admin');
	const q = event.url.searchParams.get('q')?.trim() ?? '';
	return {
		q,
		users: listUsers(event.locals.ctx, { q: q || undefined }).map((user) => ({
			id: user.id,
			name: user.name,
			email: user.email,
			role: user.role,
			active: user.active,
			hasPassword: user.passwordHash !== null
		}))
	};
};

export const actions: Actions = {
	role: async (event) => {
		const admin = requireRole(event, 'admin');
		const parsed = await parseForm(event, z.object({ userId, role: z.enum(ROLES) }));
		if (!parsed.ok) return parsed.failure;
		const result = attempt(event, parsed.values, () =>
			setUserRole(event.locals.ctx, admin.id, parsed.data.userId, parsed.data.role)
		);
		if (!result.ok) return result.failure;
		return { notice: 'Role updated.' };
	},
	active: async (event) => {
		const admin = requireRole(event, 'admin');
		const parsed = await parseForm(
			event,
			z.object({ userId, active: z.enum(['true', 'false']).transform((v) => v === 'true') })
		);
		if (!parsed.ok) return parsed.failure;
		const result = attempt(event, parsed.values, () =>
			setUserActive(event.locals.ctx, admin.id, parsed.data.userId, parsed.data.active)
		);
		if (!result.ok) return result.failure;
		return { notice: parsed.data.active ? 'User activated.' : 'User deactivated.' };
	},
	invite: async (event) => {
		requireRole(event, 'admin');
		const parsed = await parseForm(event, z.object({ userId }));
		if (!parsed.ok) return parsed.failure;
		const result = attempt(event, parsed.values, () =>
			issueInvite(event.locals.ctx, parsed.data.userId)
		);
		if (!result.ok) return result.failure;
		return {
			notice: 'Invite link created.',
			inviteUrl: `${event.url.origin}/invite/${result.value}`
		};
	}
};
