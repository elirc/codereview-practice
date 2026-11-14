import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const ROLES = ['volunteer', 'coordinator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const users = sqliteTable(
	'users',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull().unique(),
		name: text('name').notNull(),
		phone: text('phone'),
		passwordHash: text('password_hash'),
		role: text('role', { enum: ROLES }).notNull().default('volunteer'),
		emailOptIn: integer('email_opt_in', { mode: 'boolean' }).notNull().default(true),
		smsOptIn: integer('sms_opt_in', { mode: 'boolean' }).notNull().default(false),
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at').notNull()
	},
	() => [
		check('users_role_check', sql`role in ('volunteer', 'coordinator', 'admin')`),
		check('users_email_lower_check', sql`email = lower(email)`)
	]
);

export const sessions = sqliteTable(
	'sessions',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		tokenHash: text('token_hash').notNull().unique(),
		expiresAt: integer('expires_at').notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)]
);

export const inviteTokens = sqliteTable(
	'invite_tokens',
	{
		tokenHash: text('token_hash').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		expiresAt: integer('expires_at').notNull(),
		usedAt: integer('used_at'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('invite_tokens_user_idx').on(t.userId)]
);

export const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;

export const shiftSeries = sqliteTable(
	'shift_series',
	{
		id: text('id').primaryKey(),
		title: text('title').notNull(),
		location: text('location').notNull(),
		description: text('description').notNull().default(''),
		startTime: text('start_time').notNull(),
		durationMinutes: integer('duration_minutes').notNull(),
		capacity: integer('capacity').notNull(),
		freq: text('freq', { enum: FREQUENCIES }).notNull(),
		interval: integer('interval').notNull().default(1),
		byWeekday: text('by_weekday'),
		byMonthDay: integer('by_month_day'),
		dtstart: text('dtstart').notNull(),
		until: text('until'),
		count: integer('count'),
		materializedThrough: text('materialized_through'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	() => [
		check('shift_series_duration_check', sql`duration_minutes between 15 and 720`),
		check('shift_series_capacity_check', sql`capacity between 1 and 500`),
		check('shift_series_freq_check', sql`freq in ('DAILY', 'WEEKLY', 'MONTHLY')`),
		check('shift_series_interval_check', sql`"interval" between 1 and 52`),
		check(
			'shift_series_month_day_check',
			sql`by_month_day is null or by_month_day = -1 or by_month_day between 1 and 31`
		),
		check('shift_series_count_check', sql`"count" is null or "count" between 1 and 500`),
		check('shift_series_end_check', sql`"until" is null or "count" is null`)
	]
);

export const EXCEPTION_KINDS = ['cancelled', 'modified'] as const;

export const seriesExceptions = sqliteTable(
	'series_exceptions',
	{
		id: text('id').primaryKey(),
		seriesId: text('series_id')
			.notNull()
			.references(() => shiftSeries.id, { onDelete: 'cascade' }),
		occurrenceDate: text('occurrence_date').notNull(),
		kind: text('kind', { enum: EXCEPTION_KINDS }).notNull(),
		startTime: text('start_time'),
		durationMinutes: integer('duration_minutes'),
		capacity: integer('capacity'),
		location: text('location'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		uniqueIndex('series_exceptions_series_date_unique').on(t.seriesId, t.occurrenceDate),
		check('series_exceptions_kind_check', sql`kind in ('cancelled', 'modified')`),
		check(
			'series_exceptions_duration_check',
			sql`duration_minutes is null or duration_minutes between 15 and 720`
		),
		check('series_exceptions_capacity_check', sql`capacity is null or capacity between 1 and 500`)
	]
);

export const SHIFT_STATUSES = ['scheduled', 'cancelled'] as const;

export const shifts = sqliteTable(
	'shifts',
	{
		id: text('id').primaryKey(),
		seriesId: text('series_id').references(() => shiftSeries.id),
		occurrenceDate: text('occurrence_date'),
		title: text('title').notNull(),
		location: text('location').notNull(),
		startsAt: integer('starts_at').notNull(),
		endsAt: integer('ends_at').notNull(),
		capacity: integer('capacity').notNull(),
		status: text('status', { enum: SHIFT_STATUSES }).notNull().default('scheduled'),
		detached: integer('detached', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		uniqueIndex('shifts_series_occurrence_unique').on(t.seriesId, t.occurrenceDate),
		index('shifts_starts_at_idx').on(t.startsAt),
		check('shifts_time_check', sql`ends_at > starts_at`),
		check('shifts_capacity_check', sql`capacity between 1 and 500`),
		check('shifts_status_check', sql`status in ('scheduled', 'cancelled')`)
	]
);

export const SIGNUP_STATUSES = ['confirmed', 'waitlisted', 'cancelled'] as const;
export type SignupStatus = (typeof SIGNUP_STATUSES)[number];

export const signups = sqliteTable(
	'signups',
	{
		id: text('id').primaryKey(),
		shiftId: text('shift_id')
			.notNull()
			.references(() => shifts.id),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		status: text('status', { enum: SIGNUP_STATUSES }).notNull(),
		waitlistSeq: integer('waitlist_seq'),
		attended: integer('attended', { mode: 'boolean' }),
		createdAt: integer('created_at').notNull(),
		cancelledAt: integer('cancelled_at')
	},
	(t) => [
		uniqueIndex('signups_active_unique')
			.on(t.shiftId, t.userId)
			.where(sql`status != 'cancelled'`),
		uniqueIndex('signups_waitlist_seq_unique').on(t.shiftId, t.waitlistSeq),
		index('signups_user_status_idx').on(t.userId, t.status),
		check('signups_status_check', sql`status in ('confirmed', 'waitlisted', 'cancelled')`)
	]
);

export const OUTBOX_STATUSES = ['pending', 'sending', 'sent', 'skipped', 'failed', 'dead'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
export const CHANNELS = ['email', 'sms'] as const;
export type Channel = (typeof CHANNELS)[number];

export const outbox = sqliteTable(
	'outbox',
	{
		id: text('id').primaryKey(),
		dedupeKey: text('dedupe_key').notNull().unique(),
		channel: text('channel', { enum: CHANNELS }).notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		template: text('template').notNull(),
		payload: text('payload').notNull(),
		status: text('status', { enum: OUTBOX_STATUSES }).notNull().default('pending'),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: integer('next_attempt_at').notNull(),
		lockedAt: integer('locked_at'),
		providerMessageId: text('provider_message_id'),
		lastError: text('last_error'),
		createdAt: integer('created_at').notNull(),
		sentAt: integer('sent_at')
	},
	(t) => [
		index('outbox_status_next_idx').on(t.status, t.nextAttemptAt),
		check('outbox_channel_check', sql`channel in ('email', 'sms')`),
		check(
			'outbox_status_check',
			sql`status in ('pending', 'sending', 'sent', 'skipped', 'failed', 'dead')`
		)
	]
);

export const jobs = sqliteTable('jobs', {
	name: text('name').primaryKey(),
	intervalSeconds: integer('interval_seconds').notNull(),
	nextRunAt: integer('next_run_at').notNull(),
	lockedAt: integer('locked_at'),
	lastStartedAt: integer('last_started_at'),
	lastFinishedAt: integer('last_finished_at'),
	lastStatus: text('last_status'),
	lastError: text('last_error'),
	consecutiveFailures: integer('consecutive_failures').notNull().default(0)
});

export const IMPORT_MODES = ['dry_run', 'commit'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export const importRuns = sqliteTable(
	'import_runs',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		filename: text('filename').notNull(),
		mode: text('mode', { enum: IMPORT_MODES }).notNull(),
		totalRows: integer('total_rows').notNull(),
		created: integer('created').notNull(),
		updated: integer('updated').notNull(),
		failed: integer('failed').notNull(),
		errors: text('errors').notNull(),
		createdAt: integer('created_at').notNull()
	},
	() => [check('import_runs_mode_check', sql`mode in ('dry_run', 'commit')`)]
);

export type UserRow = typeof users.$inferSelect;
export type ShiftSeriesRow = typeof shiftSeries.$inferSelect;
export type SeriesExceptionRow = typeof seriesExceptions.$inferSelect;
export type ShiftRow = typeof shifts.$inferSelect;
export type SignupRow = typeof signups.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
