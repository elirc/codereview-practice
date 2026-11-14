import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shiftSeries, shifts, signups, users } from '../../src/lib/server/db/schema';
import { isUniqueViolation, sqliteErrorCode } from '../../src/lib/server/db/client';
import { createTestContext, type TestContext } from '../support/context';

let ctx: TestContext;

beforeEach(() => {
	ctx = createTestContext(Date.UTC(2026, 0, 5, 12));
});

afterEach(() => ctx.close());

function addUser(email: string) {
	const id = randomUUID();
	ctx.db.insert(users).values({ id, email, name: email, createdAt: 0 }).run();
	return id;
}

function addShift(startsAt = 1_000, endsAt = 2_000) {
	const id = randomUUID();
	ctx.db
		.insert(shifts)
		.values({
			id,
			title: 'Pantry',
			location: 'Hall',
			startsAt,
			endsAt,
			capacity: 2,
			createdAt: 0,
			updatedAt: 0
		})
		.run();
	return id;
}

function catchError(fn: () => unknown): unknown {
	try {
		fn();
	} catch (err) {
		return err;
	}
	throw new Error('expected an error');
}

describe('database setup', () => {
	it('applies the connection pragmas', () => {
		const { sqlite } = ctx.connection;
		expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
		expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
		expect(sqlite.pragma('synchronous', { simple: true })).toBe(1);
	});

	it('allows one active signup per user and shift but keeps cancelled history', () => {
		const userId = addUser('a@example.org');
		const shiftId = addShift();
		const base = { shiftId, userId, createdAt: 0 };
		ctx.db
			.insert(signups)
			.values({ ...base, id: randomUUID(), status: 'cancelled', cancelledAt: 1 })
			.run();
		ctx.db.insert(signups).values({ ...base, id: randomUUID(), status: 'confirmed' }).run();
		const err = catchError(() =>
			ctx.db
				.insert(signups)
				.values({ ...base, id: randomUUID(), status: 'waitlisted', waitlistSeq: 1 })
				.run()
		);
		expect(isUniqueViolation(err)).toBe(true);
	});

	it('rejects a shift that does not end after it starts', () => {
		const err = catchError(() => addShift(2_000, 2_000));
		expect(sqliteErrorCode(err)).toBe('SQLITE_CONSTRAINT_CHECK');
	});

	it('rejects a series with both an end date and a count', () => {
		const err = catchError(() =>
			ctx.db
				.insert(shiftSeries)
				.values({
					id: randomUUID(),
					title: 'Weekly',
					location: 'Hall',
					startTime: '09:00',
					durationMinutes: 60,
					capacity: 3,
					freq: 'DAILY',
					interval: 1,
					dtstart: '2026-01-01',
					until: '2026-02-01',
					count: 4,
					createdAt: 0,
					updatedAt: 0
				})
				.run()
		);
		expect(sqliteErrorCode(err)).toBe('SQLITE_CONSTRAINT_CHECK');
	});

	it('rejects upper-case emails', () => {
		const err = catchError(() => addUser('Upper@example.org'));
		expect(sqliteErrorCode(err)).toBe('SQLITE_CONSTRAINT_CHECK');
	});
});
