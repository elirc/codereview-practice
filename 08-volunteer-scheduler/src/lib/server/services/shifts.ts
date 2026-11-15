import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { addDays, type CivilDate } from '../../domain/dates';
import { startOfOrgDay, wallTimeToInstant } from '../../domain/time';
import type { AppContext } from '../context';
import { IMMEDIATE, type Tx } from '../db/client';
import { shiftSeries, shifts, signups, users, type ShiftRow } from '../db/schema';
import { DomainError, notFound } from '../errors';
import {
	enqueueShiftCancelled,
	enqueueShiftChanged,
	enqueueSignupNotice
} from '../outbox/enqueue';
import { promoteWaitlist } from './waitlist';

const MINUTE_MS = 60_000;

export interface ShiftValues {
	title: string;
	location: string;
	startsAt: number;
	endsAt: number;
	capacity: number;
	detached?: boolean;
}

export interface OneOffShiftInput {
	title: string;
	location: string;
	date: CivilDate;
	startTime: string;
	durationMinutes: number;
	capacity: number;
}

export function getShift(tx: Tx, shiftId: string): ShiftRow | undefined {
	return tx.select().from(shifts).where(eq(shifts.id, shiftId)).get();
}

function activeSignupUserIds(tx: Tx, shiftId: string): string[] {
	return tx
		.select({ userId: signups.userId })
		.from(signups)
		.where(and(eq(signups.shiftId, shiftId), inArray(signups.status, ['confirmed', 'waitlisted'])))
		.all()
		.map((row) => row.userId);
}

export function sameShiftValues(shift: ShiftRow, next: ShiftValues): boolean {
	return (
		shift.title === next.title &&
		shift.location === next.location &&
		shift.startsAt === next.startsAt &&
		shift.endsAt === next.endsAt &&
		shift.capacity === next.capacity &&
		(next.detached === undefined || shift.detached === next.detached)
	);
}

/**
 * Updates a scheduled shift, notifying its volunteers when the start moves
 * and filling from the waitlist when capacity grows.
 */
export function applyShiftChanges(
	tx: Tx,
	now: number,
	shift: ShiftRow,
	next: ShiftValues
): ShiftRow {
	const updated = tx
		.update(shifts)
		.set({ ...next, updatedAt: now })
		.where(eq(shifts.id, shift.id))
		.returning()
		.get();
	if (next.startsAt !== shift.startsAt) {
		enqueueShiftChanged(tx, now, shift.id, next.startsAt, activeSignupUserIds(tx, shift.id));
	}
	if (next.capacity > shift.capacity) {
		for (const signup of promoteWaitlist(tx, updated)) {
			enqueueSignupNotice(tx, now, 'waitlist-promoted', signup);
		}
	}
	return updated;
}

/** Cancels the shift and its active signups; returns false if it was already cancelled. */
export function cancelShiftTx(tx: Tx, now: number, shiftId: string): boolean {
	const result = tx
		.update(shifts)
		.set({ status: 'cancelled', updatedAt: now })
		.where(and(eq(shifts.id, shiftId), eq(shifts.status, 'scheduled')))
		.run();
	if (result.changes === 0) return false;
	const affected = tx
		.update(signups)
		.set({ status: 'cancelled', cancelledAt: now })
		.where(and(eq(signups.shiftId, shiftId), inArray(signups.status, ['confirmed', 'waitlisted'])))
		.returning({ userId: signups.userId })
		.all();
	enqueueShiftCancelled(tx, now, shiftId, affected.map((row) => row.userId));
	return true;
}

function oneOffValues(ctx: AppContext, input: OneOffShiftInput): ShiftValues {
	const startsAt = wallTimeToInstant(input.date, input.startTime, ctx.zone);
	if (startsAt <= ctx.now()) {
		throw new DomainError('starts_in_past', 422, 'The shift must start in the future.');
	}
	return {
		title: input.title,
		location: input.location,
		startsAt,
		endsAt: startsAt + input.durationMinutes * MINUTE_MS,
		capacity: input.capacity
	};
}

export function createShift(ctx: AppContext, input: OneOffShiftInput): ShiftRow {
	const now = ctx.now();
	const values = oneOffValues(ctx, input);
	return ctx.db
		.insert(shifts)
		.values({ id: randomUUID(), ...values, createdAt: now, updatedAt: now })
		.returning()
		.get();
}

function editableShift(tx: Tx, shiftId: string, now: number): ShiftRow {
	const shift = getShift(tx, shiftId);
	if (!shift) throw notFound('Shift not found.');
	if (shift.status !== 'scheduled') {
		throw new DomainError('shift_cancelled', 409, 'This shift has been cancelled.');
	}
	if (shift.startsAt <= now) {
		throw new DomainError('shift_started', 422, 'This shift has already started.');
	}
	return shift;
}

/** Edits a one-off shift. Series occurrences are changed through exceptions. */
export function updateShift(ctx: AppContext, shiftId: string, input: OneOffShiftInput): ShiftRow {
	const now = ctx.now();
	const values = oneOffValues(ctx, input);
	return ctx.db.transaction((tx) => {
		const shift = editableShift(tx, shiftId, now);
		if (shift.seriesId) {
			throw new DomainError(
				'series_occurrence',
				422,
				'This shift belongs to a series; change it as an occurrence instead.'
			);
		}
		return applyShiftChanges(tx, now, shift, values);
	}, IMMEDIATE);
}

/** Cancels a shift; cancelling an already cancelled shift does nothing. */
export function cancelShift(ctx: AppContext, shiftId: string): boolean {
	const now = ctx.now();
	return ctx.db.transaction((tx) => {
		const shift = getShift(tx, shiftId);
		if (!shift) throw notFound('Shift not found.');
		if (shift.status === 'cancelled') return false;
		if (shift.startsAt <= now) {
			throw new DomainError('shift_started', 422, 'This shift has already started.');
		}
		return cancelShiftTx(tx, now, shiftId);
	}, IMMEDIATE);
}

export interface ShiftFilter {
	from: CivilDate;
	to: CivilDate;
	status?: 'scheduled' | 'cancelled';
	q?: string;
	seriesId?: string;
}

export interface ShiftListItem {
	shift: ShiftRow;
	confirmed: number;
	waitlisted: number;
}

export const confirmedCountSql = sql<number>`(select count(*) from signups s where s.shift_id = ${shifts.id} and s.status = 'confirmed')`;
const waitlistedCountSql = sql<number>`(select count(*) from signups s where s.shift_id = ${shifts.id} and s.status = 'waitlisted')`;

export function listShifts(ctx: AppContext, filter: ShiftFilter, limit = 500): ShiftListItem[] {
	const conditions: SQL[] = [
		gte(shifts.startsAt, startOfOrgDay(filter.from, ctx.zone)),
		lt(shifts.startsAt, startOfOrgDay(addDays(filter.to, 1), ctx.zone))
	];
	if (filter.status) conditions.push(eq(shifts.status, filter.status));
	if (filter.seriesId) conditions.push(eq(shifts.seriesId, filter.seriesId));
	if (filter.q) {
		const pattern = `%${filter.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		conditions.push(sql`lower(${shifts.title}) like ${pattern} escape '\\'`);
	}
	return ctx.db
		.select({ shift: shifts, confirmed: confirmedCountSql, waitlisted: waitlistedCountSql })
		.from(shifts)
		.where(and(...conditions))
		.orderBy(asc(shifts.startsAt), asc(shifts.id))
		.limit(limit)
		.all();
}

export interface RosterEntry {
	shiftId: string;
	signupId: string;
	userId: string;
	name: string;
	email: string;
	phone: string | null;
	status: 'confirmed' | 'waitlisted' | 'cancelled';
	waitlistSeq: number | null;
	attended: boolean | null;
	createdAt: number;
	cancelledAt: number | null;
}

export function roster(tx: Tx, shiftId: string): RosterEntry[] {
	return rosters(tx, [shiftId]);
}

/** Roster entries for several shifts, in roster order within each shift. */
export function rosters(tx: Tx, shiftIds: readonly string[]): RosterEntry[] {
	if (shiftIds.length === 0) return [];
	return tx
		.select({
			shiftId: signups.shiftId,
			signupId: signups.id,
			userId: users.id,
			name: users.name,
			email: users.email,
			phone: users.phone,
			status: signups.status,
			waitlistSeq: signups.waitlistSeq,
			attended: signups.attended,
			createdAt: signups.createdAt,
			cancelledAt: signups.cancelledAt
		})
		.from(signups)
		.innerJoin(users, eq(signups.userId, users.id))
		.where(inArray(signups.shiftId, [...shiftIds]))
		.orderBy(
			asc(signups.shiftId),
			sql`case ${signups.status} when 'confirmed' then 0 when 'waitlisted' then 1 else 2 end`,
			asc(signups.waitlistSeq),
			asc(signups.createdAt),
			asc(users.name)
		)
		.all();
}

export function getShiftDetail(ctx: AppContext, shiftId: string) {
	const shift = getShift(ctx.db, shiftId);
	if (!shift) return null;
	const series = shift.seriesId
		? ctx.db.select().from(shiftSeries).where(eq(shiftSeries.id, shift.seriesId)).get()
		: undefined;
	return { shift, series: series ?? null, roster: roster(ctx.db, shiftId) };
}
