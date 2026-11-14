import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { formatInstant } from '../../domain/time';
import type { AppContext } from '../context';
import {
	shifts,
	signups,
	users,
	type OutboxRow,
	type ShiftRow,
	type SignupRow,
	type SignupStatus,
	type UserRow
} from '../db/schema';
import { shiftChangedPayload, shiftPayload, signupPayload } from './templates';

/** The outbox row cannot be interpreted; retrying will not help. */
export class PayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PayloadError';
	}
}

export interface RenderedMessage {
	to: string;
	subject: string;
	text: string;
}

export type Delivery =
	| { action: 'skip'; reason: string }
	| { action: 'send'; message: RenderedMessage };

function skip(reason: string): Delivery {
	return { action: 'skip', reason };
}

function parsePayload<S extends z.ZodTypeAny>(row: OutboxRow, schema: S): z.output<S> {
	let raw: unknown;
	try {
		raw = JSON.parse(row.payload);
	} catch {
		throw new PayloadError('Payload is not valid JSON.');
	}
	const result = schema.safeParse(raw);
	if (!result.success) throw new PayloadError(`Payload does not match template ${row.template}.`);
	return result.data;
}

function loadShift(ctx: AppContext, shiftId: string): ShiftRow {
	const shift = ctx.db.select().from(shifts).where(eq(shifts.id, shiftId)).get();
	if (!shift) throw new PayloadError(`Shift ${shiftId} does not exist.`);
	return shift;
}

function loadSignup(ctx: AppContext, signupId: string): SignupRow {
	const signup = ctx.db.select().from(signups).where(eq(signups.id, signupId)).get();
	if (!signup) throw new PayloadError(`Signup ${signupId} does not exist.`);
	return signup;
}

function waitlistPosition(ctx: AppContext, signup: SignupRow): number {
	const row = ctx.db
		.select({ ahead: sql<number>`count(*)` })
		.from(signups)
		.where(
			and(
				eq(signups.shiftId, signup.shiftId),
				eq(signups.status, 'waitlisted'),
				lt(signups.waitlistSeq, signup.waitlistSeq ?? 0)
			)
		)
		.get();
	return (row?.ahead ?? 0) + 1;
}

function describe(ctx: AppContext, shift: ShiftRow): string {
	return `${shift.title} at ${shift.location} on ${formatInstant(shift.startsAt, ctx.zone)}`;
}

const SIGNUP_STATUS_REQUIRED: Record<string, SignupStatus | null> = {
	'signup-confirmed': 'confirmed',
	'signup-waitlisted': 'waitlisted',
	'waitlist-promoted': 'confirmed',
	'signup-cancelled': null
};

function content(ctx: AppContext, row: OutboxRow): Delivery | { subject: string; text: string } {
	const now = ctx.now();
	switch (row.template) {
		case 'signup-confirmed':
		case 'signup-waitlisted':
		case 'waitlist-promoted':
		case 'signup-cancelled': {
			const payload = parsePayload(row, signupPayload);
			const signup = loadSignup(ctx, payload.signupId);
			const required = SIGNUP_STATUS_REQUIRED[row.template];
			if (required && signup.status !== required) return skip(`signup is ${signup.status}`);
			const shift = loadShift(ctx, signup.shiftId);
			const what = describe(ctx, shift);
			if (row.template === 'signup-confirmed') {
				return { subject: `Confirmed: ${shift.title}`, text: `You're confirmed for ${what}.` };
			}
			if (row.template === 'signup-waitlisted') {
				const position = waitlistPosition(ctx, signup);
				return {
					subject: `Waitlisted: ${shift.title}`,
					text: `${what} is full. You're number ${position} on the waitlist.`
				};
			}
			if (row.template === 'waitlist-promoted') {
				return {
					subject: `A spot opened up: ${shift.title}`,
					text: `Good news: you're now confirmed for ${what}.`
				};
			}
			return {
				subject: `Removed from ${shift.title}`,
				text: `A coordinator removed you from ${what}.`
			};
		}
		case 'shift-cancelled': {
			const shift = loadShift(ctx, parsePayload(row, shiftPayload).shiftId);
			return {
				subject: `Cancelled: ${shift.title}`,
				text: `${describe(ctx, shift)} has been cancelled. Thank you for signing up.`
			};
		}
		case 'shift-changed': {
			const shift = loadShift(ctx, parsePayload(row, shiftChangedPayload).shiftId);
			const startsAt = formatInstant(shift.startsAt, ctx.zone);
			return {
				subject: `Time changed: ${shift.title}`,
				text: `${shift.title} at ${shift.location} now starts ${startsAt}.`
			};
		}
		case 'reminder-24h': {
			const shift = loadShift(ctx, parsePayload(row, shiftPayload).shiftId);
			const confirmed = ctx.db
				.select({ id: signups.id })
				.from(signups)
				.where(
					and(
						eq(signups.shiftId, shift.id),
						eq(signups.userId, row.userId),
						eq(signups.status, 'confirmed')
					)
				)
				.orderBy(asc(signups.createdAt))
				.get();
			if (!confirmed) return skip('no confirmed signup');
			if (shift.status !== 'scheduled') return skip('shift cancelled');
			if (now >= shift.startsAt) return skip('shift already started');
			return { subject: `Reminder: ${shift.title}`, text: `Reminder: ${describe(ctx, shift)}.` };
		}
		default:
			throw new PayloadError(`Unknown template ${row.template}.`);
	}
}

function recipientProblem(user: UserRow | undefined, row: OutboxRow): string | null {
	if (!user || !user.active) return 'user inactive';
	if (row.channel === 'email' && !user.emailOptIn) return 'email opt-out';
	if (row.channel === 'sms' && (!user.smsOptIn || !user.phone)) return 'sms opt-out';
	return null;
}

/** Checks a claimed row against current state and renders it from current data. */
export function prepareDelivery(ctx: AppContext, row: OutboxRow): Delivery {
	const rendered = content(ctx, row);
	if ('action' in rendered) return rendered;
	const user = ctx.db.select().from(users).where(eq(users.id, row.userId)).get();
	const problem = recipientProblem(user, row);
	if (problem || !user) return skip(problem ?? 'user inactive');
	if (row.channel === 'email') {
		return { action: 'send', message: { to: user.email, ...rendered } };
	}
	return {
		action: 'send',
		message: { to: user.phone ?? '', subject: rendered.subject, text: rendered.text }
	};
}
