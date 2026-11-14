import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';
import type { AppContext } from '../context';
import { IMMEDIATE, isBusyError } from '../db/client';
import { outbox, type OutboxRow } from '../db/schema';
import { PermanentProviderError, type Providers, type SendResult } from './providers';
import { PayloadError, prepareDelivery, type Delivery, type RenderedMessage } from './render';
import { backoffMs, isQuietHours, MAX_ATTEMPTS, quietHoursEnd } from './schedule';

export const BATCH_SIZE = 20;
export const SENDING_LOCK_MS = 5 * 60_000;

export interface DispatcherDeps extends Providers {
	ctx: AppContext;
}

export type RowOutcome = 'sent' | 'skipped' | 'failed' | 'retry' | 'dead' | 'deferred' | 'lost';

export interface DispatchResult {
	busy: boolean;
	claimed: number;
	outcomes: Record<string, RowOutcome>;
}

/**
 * Releases expired `sending` locks, then marks up to `limit` due rows as
 * `sending` and returns them with their incremented attempt counts.
 */
export function claimBatch(ctx: AppContext, limit = BATCH_SIZE): OutboxRow[] {
	const now = ctx.now();
	const claimed = ctx.db.transaction((tx) => {
		tx.update(outbox)
			.set({ status: 'pending', lockedAt: null })
			.where(and(eq(outbox.status, 'sending'), lt(outbox.lockedAt, now - SENDING_LOCK_MS)))
			.run();
		const due = tx
			.select({ id: outbox.id })
			.from(outbox)
			.where(and(eq(outbox.status, 'pending'), lte(outbox.nextAttemptAt, now)))
			.orderBy(asc(outbox.nextAttemptAt), asc(outbox.id))
			.limit(limit)
			.all();
		if (due.length === 0) return [];
		const ids = due.map((row) => row.id);
		return tx
			.update(outbox)
			.set({ status: 'sending', lockedAt: now, attempts: sql`${outbox.attempts} + 1` })
			.where(and(eq(outbox.status, 'pending'), inArray(outbox.id, ids)))
			.returning()
			.all();
	}, IMMEDIATE);
	return claimed.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || (a.id < b.id ? -1 : 1));
}

type RowUpdate = SQLiteUpdateSetSource<typeof outbox>;

function record(ctx: AppContext, id: string, values: RowUpdate): boolean {
	const result = ctx.db
		.update(outbox)
		.set(values)
		.where(and(eq(outbox.id, id), eq(outbox.status, 'sending')))
		.run();
	return result.changes > 0;
}

function errorMessage(err: unknown): string {
	const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	return message.slice(0, 500);
}

function failure(status: 'failed' | 'dead', err: unknown): RowUpdate {
	return { status, lockedAt: null, lastError: errorMessage(err) };
}

async function send(deps: DispatcherDeps, row: OutboxRow, message: RenderedMessage) {
	const options = { idempotencyKey: row.dedupeKey };
	if (row.channel === 'email') return deps.email.send(message, options);
	return deps.sms.send({ to: message.to, text: message.text }, options);
}

export async function processRow(deps: DispatcherDeps, row: OutboxRow): Promise<RowOutcome> {
	const { ctx } = deps;
	const log = ctx.logger.child({
		outboxId: row.id,
		template: row.template,
		channel: row.channel,
		attempt: row.attempts
	});

	let delivery: Delivery;
	try {
		delivery = prepareDelivery(ctx, row);
	} catch (err) {
		if (!(err instanceof PayloadError)) throw err;
		log.warn({ err }, 'outbox row has an unusable payload');
		const ok = record(ctx, row.id, { status: 'failed', lockedAt: null, lastError: err.message });
		return ok ? 'failed' : 'lost';
	}

	if (delivery.action === 'skip') {
		log.info({ reason: delivery.reason }, 'notification skipped');
		const ok = record(ctx, row.id, {
			status: 'skipped',
			lockedAt: null,
			lastError: `skipped: ${delivery.reason}`
		});
		return ok ? 'skipped' : 'lost';
	}

	const now = ctx.now();
	if (row.channel === 'sms' && isQuietHours(now, ctx.zone)) {
		const ok = record(ctx, row.id, {
			status: 'pending',
			lockedAt: null,
			nextAttemptAt: quietHoursEnd(now, ctx.zone),
			attempts: sql`${outbox.attempts} - 1`
		});
		log.info('sms deferred until quiet hours end');
		return ok ? 'deferred' : 'lost';
	}

	let result: SendResult;
	try {
		result = await send(deps, row, delivery.message);
	} catch (err) {
		const finished = ctx.now();
		if (err instanceof PermanentProviderError) {
			log.warn({ err }, 'provider rejected notification permanently');
			const ok = record(ctx, row.id, failure('failed', err));
			return ok ? 'failed' : 'lost';
		}
		if (row.attempts >= MAX_ATTEMPTS) {
			log.error({ err }, 'notification dead after final attempt');
			const ok = record(ctx, row.id, failure('dead', err));
			return ok ? 'dead' : 'lost';
		}
		const nextAttemptAt = finished + backoffMs(row.attempts);
		log.warn({ err, nextAttemptAt }, 'notification send failed; will retry');
		const ok = record(ctx, row.id, {
			status: 'pending',
			lockedAt: null,
			nextAttemptAt,
			lastError: errorMessage(err)
		});
		return ok ? 'retry' : 'lost';
	}

	log.info({ providerMessageId: result.providerMessageId }, 'notification sent');
	try {
		const ok = record(ctx, row.id, {
			status: 'sent',
			lockedAt: null,
			sentAt: ctx.now(),
			providerMessageId: result.providerMessageId,
			lastError: null
		});
		return ok ? 'sent' : 'lost';
	} catch (err) {
		log.error({ err }, 'could not record a sent notification');
		return 'lost';
	}
}

/** One dispatcher tick: claim a batch and process every row in it. */
export async function dispatchOnce(deps: DispatcherDeps): Promise<DispatchResult> {
	const { ctx } = deps;
	let batch: OutboxRow[];
	try {
		batch = claimBatch(ctx);
	} catch (err) {
		if (isBusyError(err)) {
			ctx.logger.warn({ err }, 'database busy; skipping dispatch tick');
			return { busy: true, claimed: 0, outcomes: {} };
		}
		throw err;
	}

	const outcomes: Record<string, RowOutcome> = {};
	for (const row of batch) {
		try {
			outcomes[row.id] = await processRow(deps, row);
		} catch (err) {
			ctx.logger.error({ err, outboxId: row.id }, 'outbox row processing failed');
			outcomes[row.id] = 'lost';
		}
	}
	if (batch.length > 0) ctx.logger.info({ claimed: batch.length }, 'dispatch batch finished');
	return { busy: false, claimed: batch.length, outcomes };
}
