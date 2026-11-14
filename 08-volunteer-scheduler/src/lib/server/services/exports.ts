import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { addDays, daysBetween, type CivilDate } from '../../domain/dates';
import { isoWithOffset, orgDate, startOfOrgDay } from '../../domain/time';
import type { AppContext } from '../context';
import { shifts, signups, users } from '../db/schema';
import { toCsv } from '../csv/write';
import { DomainError, notFound } from '../errors';
import { getShift, roster } from './shifts';

export const MAX_EXPORT_DAYS = 366;

export interface CsvFile {
	filename: string;
	body: string;
}

function attendedCell(attended: boolean | null): string {
	if (attended === null) return '';
	return attended ? 'yes' : 'no';
}

function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'shift'
	);
}

/** Confirmed and waitlisted volunteers for one shift. */
export function rosterCsv(ctx: AppContext, shiftId: string): CsvFile {
	const shift = getShift(ctx.db, shiftId);
	if (!shift) throw notFound('Shift not found.');
	const zone = ctx.zone;
	const rows = roster(ctx.db, shiftId)
		.filter((entry) => entry.status !== 'cancelled')
		.map((entry) => [
			shift.title,
			isoWithOffset(shift.startsAt, zone),
			isoWithOffset(shift.endsAt, zone),
			shift.location,
			entry.name,
			entry.email,
			entry.phone ?? '',
			entry.status,
			entry.waitlistSeq === null ? '' : String(entry.waitlistSeq),
			attendedCell(entry.attended),
			isoWithOffset(entry.createdAt, zone)
		]);
	const header = [
		'shift_title',
		'shift_starts_at',
		'shift_ends_at',
		'location',
		'name',
		'email',
		'phone',
		'status',
		'waitlist_seq',
		'attended',
		'signed_up_at'
	];
	return {
		filename: `roster-${orgDate(shift.startsAt, zone)}-${slug(shift.title)}.csv`,
		body: toCsv([header, ...rows])
	};
}

/** Every signup on shifts starting within the inclusive range of organisation dates. */
export function signupsCsv(ctx: AppContext, from: CivilDate, to: CivilDate): CsvFile {
	const days = daysBetween(from, to) + 1;
	if (days < 1 || days > MAX_EXPORT_DAYS) {
		throw new DomainError(
			'validation_failed',
			400,
			`Choose a range of 1 to ${MAX_EXPORT_DAYS} days.`,
			{ fields: [{ path: 'to', message: 'Out of range.' }] }
		);
	}
	const zone = ctx.zone;
	const rows = ctx.db
		.select({
			shiftId: shifts.id,
			title: shifts.title,
			location: shifts.location,
			startsAt: shifts.startsAt,
			endsAt: shifts.endsAt,
			shiftStatus: shifts.status,
			name: users.name,
			email: users.email,
			phone: users.phone,
			status: signups.status,
			attended: signups.attended,
			createdAt: signups.createdAt,
			cancelledAt: signups.cancelledAt
		})
		.from(signups)
		.innerJoin(shifts, eq(signups.shiftId, shifts.id))
		.innerJoin(users, eq(signups.userId, users.id))
		.where(
			and(
				gte(shifts.startsAt, startOfOrgDay(from, zone)),
				lt(shifts.startsAt, startOfOrgDay(addDays(to, 1), zone))
			)
		)
		.orderBy(asc(shifts.startsAt), asc(shifts.id), sql`lower(${users.name})`)
		.all();
	const header = [
		'shift_id',
		'shift_title',
		'shift_starts_at',
		'shift_ends_at',
		'location',
		'shift_status',
		'name',
		'email',
		'phone',
		'status',
		'attended',
		'signed_up_at',
		'cancelled_at'
	];
	const body = rows.map((row) => [
		row.shiftId,
		row.title,
		isoWithOffset(row.startsAt, zone),
		isoWithOffset(row.endsAt, zone),
		row.location,
		row.shiftStatus,
		row.name,
		row.email,
		row.phone ?? '',
		row.status,
		attendedCell(row.attended),
		isoWithOffset(row.createdAt, zone),
		row.cancelledAt === null ? '' : isoWithOffset(row.cancelledAt, zone)
	]);
	return { filename: `signups-${from}-to-${to}.csv`, body: toCsv([header, ...body]) };
}
