import { error, type RequestEvent } from '@sveltejs/kit';
import type { Role } from '../db/schema';
import type { SessionUser } from './session';

export const MANAGER_ROLES: readonly Role[] = ['coordinator', 'admin'];

export function requireUser(event: RequestEvent): SessionUser {
	const user = event.locals.user;
	if (!user) error(401, { code: 'unauthenticated', message: 'Please sign in.' });
	return user;
}

export function requireRole(event: RequestEvent, ...roles: readonly Role[]): SessionUser {
	const user = requireUser(event);
	if (!roles.includes(user.role)) {
		error(403, { code: 'forbidden', message: 'You do not have permission to do that.' });
	}
	return user;
}

export function requireManager(event: RequestEvent): SessionUser {
	return requireRole(event, ...MANAGER_ROLES);
}

export function isManager(user: SessionUser): boolean {
	return MANAGER_ROLES.includes(user.role);
}
