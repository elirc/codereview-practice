import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm';
import { createInvite } from '../auth/invite';
import { deleteUserSessions } from '../auth/session';
import type { AppContext } from '../context';
import { IMMEDIATE } from '../db/client';
import { users, type Role, type UserRow } from '../db/schema';
import { DomainError, notFound } from '../errors';

export interface UserFilter {
	q?: string;
	role?: Role;
}

function likePattern(term: string): string {
	return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function listUsers(ctx: AppContext, filter: UserFilter = {}, limit = 500): UserRow[] {
	const conditions: SQL[] = [];
	if (filter.q) {
		const pattern = likePattern(filter.q.toLowerCase());
		const match = or(
			sql`lower(${users.name}) like ${pattern} escape '\\'`,
			sql`${users.email} like ${pattern} escape '\\'`
		);
		if (match) conditions.push(match);
	}
	if (filter.role) conditions.push(eq(users.role, filter.role));
	return ctx.db
		.select()
		.from(users)
		.where(conditions.length ? and(...conditions) : undefined)
		.orderBy(asc(users.name), asc(users.email))
		.limit(limit)
		.all();
}

function loadOther(ctx: AppContext, actorId: string, userId: string): UserRow {
	if (actorId === userId) {
		throw new DomainError('cannot_modify_self', 422, 'You cannot change your own account here.');
	}
	const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) throw notFound('User not found.');
	return user;
}

export function setUserRole(ctx: AppContext, actorId: string, userId: string, role: Role): void {
	loadOther(ctx, actorId, userId);
	ctx.db.update(users).set({ role }).where(eq(users.id, userId)).run();
}

export function setUserActive(
	ctx: AppContext,
	actorId: string,
	userId: string,
	active: boolean
): void {
	loadOther(ctx, actorId, userId);
	ctx.db.transaction((tx) => {
		tx.update(users).set({ active }).where(eq(users.id, userId)).run();
		if (!active) deleteUserSessions(tx, userId);
	}, IMMEDIATE);
}

/** Issues a fresh invite for an account that has never set a password. */
export function issueInvite(ctx: AppContext, userId: string): string {
	const now = ctx.now();
	return ctx.db.transaction((tx) => {
		const user = tx.select().from(users).where(eq(users.id, userId)).get();
		if (!user) throw notFound('User not found.');
		if (!user.active) throw new DomainError('user_inactive', 422, 'This account is deactivated.');
		if (user.passwordHash) {
			throw new DomainError('already_has_password', 422, 'This user has already set a password.');
		}
		return createInvite(tx, userId, now);
	}, IMMEDIATE);
}
