import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { outbox, users, type Channel } from '../db/schema';
import type { SignupTemplate, Template } from './templates';

export interface Recipient {
	id: string;
	phone: string | null;
	emailOptIn: boolean;
	smsOptIn: boolean;
}

/** Channels a user receives notifications on, evaluated when the row is created. */
export function channelsFor(recipient: Recipient): Channel[] {
	const channels: Channel[] = [];
	if (recipient.emailOptIn) channels.push('email');
	if (recipient.smsOptIn && recipient.phone) channels.push('sms');
	return channels;
}

function loadRecipients(tx: Tx, userIds: readonly string[]): Recipient[] {
	const unique = [...new Set(userIds)];
	if (unique.length === 0) return [];
	return tx
		.select({
			id: users.id,
			phone: users.phone,
			emailOptIn: users.emailOptIn,
			smsOptIn: users.smsOptIn
		})
		.from(users)
		.where(inArray(users.id, unique))
		.all();
}

/** Inserts one row per enabled channel; returns how many rows were new. */
function insertNotices(
	tx: Tx,
	now: number,
	recipient: Recipient,
	template: Template,
	keyParts: readonly (string | number)[],
	payload: Record<string, unknown>
): number {
	let inserted = 0;
	for (const channel of channelsFor(recipient)) {
		const result = tx
			.insert(outbox)
			.values({
				id: randomUUID(),
				dedupeKey: [template, ...keyParts, channel].join(':'),
				channel,
				userId: recipient.id,
				template,
				payload: JSON.stringify(payload),
				status: 'pending',
				attempts: 0,
				nextAttemptAt: now,
				createdAt: now
			})
			.onConflictDoNothing({ target: outbox.dedupeKey })
			.run();
		inserted += result.changes;
	}
	return inserted;
}

export function enqueueSignupNotice(
	tx: Tx,
	now: number,
	template: SignupTemplate,
	signup: { id: string; shiftId: string; userId: string }
): number {
	const [recipient] = loadRecipients(tx, [signup.userId]);
	if (!recipient) return 0;
	return insertNotices(tx, now, recipient, template, [signup.id], {
		signupId: signup.id,
		shiftId: signup.shiftId
	});
}

export function enqueueShiftCancelled(
	tx: Tx,
	now: number,
	shiftId: string,
	userIds: readonly string[]
): number {
	let inserted = 0;
	for (const recipient of loadRecipients(tx, userIds)) {
		inserted += insertNotices(tx, now, recipient, 'shift-cancelled', [shiftId, recipient.id], {
			shiftId
		});
	}
	return inserted;
}

export function enqueueShiftChanged(
	tx: Tx,
	now: number,
	shiftId: string,
	startsAt: number,
	userIds: readonly string[]
): number {
	let inserted = 0;
	for (const recipient of loadRecipients(tx, userIds)) {
		inserted += insertNotices(
			tx,
			now,
			recipient,
			'shift-changed',
			[shiftId, startsAt, recipient.id],
			{ shiftId, startsAt }
		);
	}
	return inserted;
}

export function enqueueReminders(
	tx: Tx,
	now: number,
	shiftId: string,
	userIds: readonly string[]
): number {
	let inserted = 0;
	for (const recipient of loadRecipients(tx, userIds)) {
		inserted += insertNotices(tx, now, recipient, 'reminder-24h', [shiftId, recipient.id], {
			shiftId
		});
	}
	return inserted;
}
