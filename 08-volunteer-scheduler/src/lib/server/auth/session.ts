import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { Tx } from '../db/client';
import { sessions, users, type Role } from '../db/schema';

export const SESSION_COOKIE = 'vs_session';

export interface SessionUser {
	id: string;
	email: string;
	name: string;
	role: Role;
	phone: string | null;
	emailOptIn: boolean;
	smsOptIn: boolean;
}

export interface SessionSettings {
	secure: boolean;
	ttlMs: number;
}

/** 256 bits of randomness, URL-safe. */
export function newToken(): string {
	return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function createSession(
	ctx: AppContext,
	userId: string,
	ttlMs: number
): { token: string; expiresAt: number } {
	const now = ctx.now();
	const token = newToken();
	const expiresAt = now + ttlMs;
	ctx.db
		.insert(sessions)
		.values({ id: randomUUID(), userId, tokenHash: hashToken(token), expiresAt, createdAt: now })
		.run();
	return { token, expiresAt };
}

export function findSessionUser(ctx: AppContext, token: string): SessionUser | null {
	const row = ctx.db
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			role: users.role,
			phone: users.phone,
			emailOptIn: users.emailOptIn,
			smsOptIn: users.smsOptIn
		})
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(
			and(
				eq(sessions.tokenHash, hashToken(token)),
				gt(sessions.expiresAt, ctx.now()),
				eq(users.active, true)
			)
		)
		.get();
	return row ?? null;
}

export function deleteSession(ctx: AppContext, token: string): void {
	ctx.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
}

export function deleteUserSessions(tx: Tx, userId: string): void {
	tx.delete(sessions).where(eq(sessions.userId, userId)).run();
}

export function sessionCookieOptions(settings: SessionSettings, expiresAt: number) {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: settings.secure,
		expires: new Date(expiresAt)
	};
}
