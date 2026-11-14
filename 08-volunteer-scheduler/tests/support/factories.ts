import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../src/lib/server/context';
import { users, type Role, type UserRow } from '../../src/lib/server/db/schema';

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
