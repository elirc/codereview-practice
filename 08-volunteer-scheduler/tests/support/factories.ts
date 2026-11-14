import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../src/lib/server/context';
import {
	shifts,
	signups,
	users,
	type Role,
	type ShiftRow,
	type SignupRow,
	type SignupStatus,
	type UserRow
} from '../../src/lib/server/db/schema';

let sequence = 0;

export interface UserOverrides {
	email?: string;
	name?: string;
	role?: Role;
	phone?: string | null;
	passwordHash?: string | null;
	emailOptIn?: boolean;
	smsOptIn?: boolean;
	active?: boolean;
}

export function createUser(ctx: AppContext, overrides: UserOverrides = {}): UserRow {
	sequence += 1;
	return ctx.db
		.insert(users)
		.values({
			id: randomUUID(),
			email: overrides.email ?? `user${sequence}@example.org`,
			name: overrides.name ?? `User ${sequence}`,
			role: overrides.role ?? 'volunteer',
			phone: overrides.phone ?? null,
			passwordHash: overrides.passwordHash ?? null,
			emailOptIn: overrides.emailOptIn ?? true,
			smsOptIn: overrides.smsOptIn ?? false,
			active: overrides.active ?? true,
			createdAt: ctx.now()
		})
		.returning()
		.get();
}

export interface ShiftOverrides {
	title?: string;
	location?: string;
	startsAt?: number;
	endsAt?: number;
	capacity?: number;
	status?: 'scheduled' | 'cancelled';
}

export function createShiftRow(ctx: AppContext, overrides: ShiftOverrides = {}): ShiftRow {
	const startsAt = overrides.startsAt ?? ctx.now() + 3 * 24 * 60 * 60 * 1000;
	return ctx.db
		.insert(shifts)
		.values({
			id: randomUUID(),
			title: overrides.title ?? 'Food pantry',
			location: overrides.location ?? 'Main hall',
			startsAt,
			endsAt: overrides.endsAt ?? startsAt + 2 * 60 * 60 * 1000,
			capacity: overrides.capacity ?? 3,
			status: overrides.status ?? 'scheduled',
			createdAt: ctx.now(),
			updatedAt: ctx.now()
		})
		.returning()
		.get();
}

export function createSignupRow(
	ctx: AppContext,
	shiftId: string,
	userId: string,
	status: SignupStatus = 'confirmed',
	waitlistSeq: number | null = null
): SignupRow {
	return ctx.db
		.insert(signups)
		.values({ id: randomUUID(), shiftId, userId, status, waitlistSeq, createdAt: ctx.now() })
		.returning()
		.get();
}
