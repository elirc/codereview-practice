import { and, eq, gt, isNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { IMMEDIATE, type Tx } from '../db/client';
import { inviteTokens, users } from '../db/schema';
import { DomainError } from '../errors';
import { hashToken, newToken } from './session';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Stores a single-use invite and returns the raw token for the link. */
export function createInvite(tx: Tx, userId: string, now: number): string {
	const token = newToken();
	tx.insert(inviteTokens)
		.values({ tokenHash: hashToken(token), userId, expiresAt: now + INVITE_TTL_MS, createdAt: now })
		.run();
	return token;
}

export interface InviteDetails {
	userId: string;
	name: string;
	email: string;
}

export function findInvite(ctx: AppContext, token: string): InviteDetails | null {
	const row = ctx.db
		.select({ userId: users.id, name: users.name, email: users.email })
		.from(inviteTokens)
		.innerJoin(users, eq(inviteTokens.userId, users.id))
		.where(
			and(
				eq(inviteTokens.tokenHash, hashToken(token)),
				isNull(inviteTokens.usedAt),
				gt(inviteTokens.expiresAt, ctx.now()),
				eq(users.active, true)
			)
		)
		.get();
	return row ?? null;
}

/** Consumes the invite and sets the user's password; returns the user id. */
export function acceptInvite(ctx: AppContext, token: string, passwordHash: string): string {
	const now = ctx.now();
	return ctx.db.transaction((tx) => {
		const invite = tx
			.update(inviteTokens)
			.set({ usedAt: now })
			.where(
				and(
					eq(inviteTokens.tokenHash, hashToken(token)),
					isNull(inviteTokens.usedAt),
					gt(inviteTokens.expiresAt, now)
				)
			)
			.returning({ userId: inviteTokens.userId })
			.get();
		if (!invite) {
			throw new DomainError('invite_invalid', 404, 'This invite link is invalid or has expired.');
		}
		const updated = tx
			.update(users)
			.set({ passwordHash })
			.where(and(eq(users.id, invite.userId), eq(users.active, true)))
			.returning({ id: users.id })
			.get();
		if (!updated) {
			throw new DomainError('invite_invalid', 404, 'This invite link is invalid or has expired.');
		}
		tx.update(inviteTokens)
			.set({ usedAt: now })
			.where(and(eq(inviteTokens.userId, invite.userId), isNull(inviteTokens.usedAt)))
			.run();
		return invite.userId;
	}, IMMEDIATE);
}
