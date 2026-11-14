import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { users, type UserRow } from '../db/schema';
import { dummyPasswordHash, verifyPassword } from './password';

/** The active user with this email and password, or null. */
export async function authenticate(
	ctx: AppContext,
	email: string,
	password: string
): Promise<UserRow | null> {
	const user = ctx.db.select().from(users).where(eq(users.email, email)).get();
	if (!user || !user.passwordHash || !user.active) {
		await verifyPassword(password, await dummyPasswordHash());
		return null;
	}
	return (await verifyPassword(password, user.passwordHash)) ? user : null;
}
