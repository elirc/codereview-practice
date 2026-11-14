import { eq } from 'drizzle-orm';
import { addDays } from '../src/lib/domain/dates';
import { orgDate, wallTimeToInstant } from '../src/lib/domain/time';
import { hashPassword } from '../src/lib/server/auth/password';
import { getConfig } from '../src/lib/server/config';
import type { AppContext } from '../src/lib/server/context';
import { IMMEDIATE, openDatabase } from '../src/lib/server/db/client';
import { shiftSeries, shifts, users, type Role } from '../src/lib/server/db/schema';
import { DomainError } from '../src/lib/server/errors';
import { createLogger } from '../src/lib/server/logger';
import { materializeSeries } from '../src/lib/server/services/series';
import { signUp } from '../src/lib/server/services/signups';

interface SeedUser {
	id: string;
	email: string;
	name: string;
	role: Role;
	password: string;
	phone?: string;
	smsOptIn?: boolean;
}

const SEED_USERS: SeedUser[] = [
	{
		id: '00000000-0000-4000-8000-000000000001',
		email: 'admin@example.org',
		name: 'Avery Admin',
		role: 'admin',
		password: 'admin-password'
	},
	{
		id: '00000000-0000-4000-8000-000000000002',
		email: 'coordinator@example.org',
		name: 'Casey Coordinator',
		role: 'coordinator',
		password: 'coordinator-password'
	},
	{
		id: '00000000-0000-4000-8000-000000000003',
		email: 'volunteer@example.org',
		name: 'Val Volunteer',
		role: 'volunteer',
		password: 'volunteer-password'
	},
	{
		id: '00000000-0000-4000-8000-000000000004',
		email: 'sam@example.org',
		name: 'Sam Texter',
		role: 'volunteer',
		password: 'volunteer-password',
		phone: '+15550100123',
		smsOptIn: true
	}
];

const PANTRY_SERIES_ID = '00000000-0000-4000-8000-000000000101';
const CLEANUP_SERIES_ID = '00000000-0000-4000-8000-000000000102';
const ONE_OFF_SHIFT_ID = '00000000-0000-4000-8000-000000000201';

const config = getConfig();
const logger = createLogger(config.logLevel);
const { sqlite, db } = openDatabase(config.databasePath);
const ctx: AppContext = { db, zone: config.orgTimezone, now: () => Date.now(), logger };

async function seed() {
	const hashes = new Map<string, string>();
	for (const user of SEED_USERS) hashes.set(user.email, await hashPassword(user.password));

	const now = ctx.now();
	const today = orgDate(now, ctx.zone);
	ctx.db.transaction((tx) => {
		for (const user of SEED_USERS) {
			tx.insert(users)
				.values({
					id: user.id,
					email: user.email,
					name: user.name,
					role: user.role,
					passwordHash: hashes.get(user.email) ?? null,
					phone: user.phone ?? null,
					smsOptIn: user.smsOptIn ?? false,
					createdAt: now
				})
				.onConflictDoNothing()
				.run();
		}
		const series = [
			{
				id: PANTRY_SERIES_ID,
				title: 'Evening food pantry',
				location: 'Community hall',
				description: 'Sort donations and pack bags.',
				startTime: '17:30',
				durationMinutes: 120,
				capacity: 4,
				freq: 'WEEKLY' as const,
				interval: 1,
				byWeekday: JSON.stringify(['TU', 'TH']),
				byMonthDay: null,
				dtstart: today
			},
			{
				id: CLEANUP_SERIES_ID,
				title: 'Park clean-up',
				location: 'Riverside park',
				description: 'Gloves and bags provided.',
				startTime: '09:00',
				durationMinutes: 180,
				capacity: 10,
				freq: 'MONTHLY' as const,
				interval: 1,
				byWeekday: null,
				byMonthDay: 1,
				dtstart: today
			}
		];
		for (const values of series) {
			tx.insert(shiftSeries)
				.values({ ...values, createdAt: now, updatedAt: now })
				.onConflictDoNothing()
				.run();
			const row = tx.select().from(shiftSeries).where(eq(shiftSeries.id, values.id)).get();
			if (row) materializeSeries(tx, now, ctx.zone, row);
		}
		const startsAt = wallTimeToInstant(addDays(today, 2), '10:00', ctx.zone);
		tx.insert(shifts)
			.values({
				id: ONE_OFF_SHIFT_ID,
				title: 'Warehouse inventory day',
				location: 'Depot',
				startsAt,
				endsAt: startsAt + 4 * 60 * 60 * 1000,
				capacity: 2,
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoNothing()
			.run();
	}, IMMEDIATE);

	const pantry = ctx.db
		.select({ id: shifts.id })
		.from(shifts)
		.where(eq(shifts.seriesId, PANTRY_SERIES_ID))
		.orderBy(shifts.startsAt)
		.limit(2)
		.all();
	const signupsToCreate = [
		...pantry.map((shift) => ({ userId: SEED_USERS[2].id, shiftId: shift.id })),
		{ userId: SEED_USERS[2].id, shiftId: ONE_OFF_SHIFT_ID },
		{ userId: SEED_USERS[3].id, shiftId: ONE_OFF_SHIFT_ID },
		{ userId: SEED_USERS[1].id, shiftId: ONE_OFF_SHIFT_ID }
	];
	for (const { userId, shiftId } of signupsToCreate) {
		try {
			signUp(ctx, { userId, shiftId, actor: { id: userId, role: 'volunteer' } });
		} catch (err) {
			if (!(err instanceof DomainError)) throw err;
		}
	}
	logger.info({ databasePath: config.databasePath }, 'seed data ready');
}

try {
	await seed();
} catch (err) {
	logger.error({ err }, 'seeding failed');
	process.exitCode = 1;
} finally {
	sqlite.close();
}
