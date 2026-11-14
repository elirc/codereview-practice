CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`password_hash` text,
	`role` text DEFAULT 'volunteer' NOT NULL,
	`email_opt_in` integer DEFAULT true NOT NULL,
	`sms_opt_in` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "users_role_check" CHECK(role in ('volunteer', 'coordinator', 'admin')),
	CONSTRAINT "users_email_lower_check" CHECK(email = lower(email))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `invite_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invite_tokens_user_idx` ON `invite_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `shift_series` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`location` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`start_time` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`capacity` integer NOT NULL,
	`freq` text NOT NULL,
	`interval` integer DEFAULT 1 NOT NULL,
	`by_weekday` text,
	`by_month_day` integer,
	`dtstart` text NOT NULL,
	`until` text,
	`count` integer,
	`materialized_through` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "shift_series_duration_check" CHECK(duration_minutes between 15 and 720),
	CONSTRAINT "shift_series_capacity_check" CHECK(capacity between 1 and 500),
	CONSTRAINT "shift_series_freq_check" CHECK(freq in ('DAILY', 'WEEKLY', 'MONTHLY')),
	CONSTRAINT "shift_series_interval_check" CHECK("interval" between 1 and 52),
	CONSTRAINT "shift_series_month_day_check" CHECK(by_month_day is null or by_month_day = -1 or by_month_day between 1 and 31),
	CONSTRAINT "shift_series_count_check" CHECK("count" is null or "count" between 1 and 500),
	CONSTRAINT "shift_series_end_check" CHECK("until" is null or "count" is null)
);
--> statement-breakpoint
CREATE TABLE `series_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`occurrence_date` text NOT NULL,
	`kind` text NOT NULL,
	`start_time` text,
	`duration_minutes` integer,
	`capacity` integer,
	`location` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `shift_series`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "series_exceptions_kind_check" CHECK(kind in ('cancelled', 'modified')),
	CONSTRAINT "series_exceptions_duration_check" CHECK(duration_minutes is null or duration_minutes between 15 and 720),
	CONSTRAINT "series_exceptions_capacity_check" CHECK(capacity is null or capacity between 1 and 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `series_exceptions_series_date_unique` ON `series_exceptions` (`series_id`,`occurrence_date`);--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text,
	`occurrence_date` text,
	`title` text NOT NULL,
	`location` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`capacity` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`detached` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `shift_series`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shifts_time_check" CHECK(ends_at > starts_at),
	CONSTRAINT "shifts_capacity_check" CHECK(capacity between 1 and 500),
	CONSTRAINT "shifts_status_check" CHECK(status in ('scheduled', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shifts_series_occurrence_unique` ON `shifts` (`series_id`,`occurrence_date`);--> statement-breakpoint
CREATE INDEX `shifts_starts_at_idx` ON `shifts` (`starts_at`);--> statement-breakpoint
CREATE TABLE `signups` (
	`id` text PRIMARY KEY NOT NULL,
	`shift_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`waitlist_seq` integer,
	`attended` integer,
	`created_at` integer NOT NULL,
	`cancelled_at` integer,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "signups_status_check" CHECK(status in ('confirmed', 'waitlisted', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signups_active_unique` ON `signups` (`shift_id`,`user_id`) WHERE status != 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX `signups_waitlist_seq_unique` ON `signups` (`shift_id`,`waitlist_seq`);--> statement-breakpoint
CREATE INDEX `signups_user_status_idx` ON `signups` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`channel` text NOT NULL,
	`user_id` text NOT NULL,
	`template` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`locked_at` integer,
	`provider_message_id` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_channel_check" CHECK(channel in ('email', 'sms')),
	CONSTRAINT "outbox_status_check" CHECK(status in ('pending', 'sending', 'sent', 'skipped', 'failed', 'dead'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_dedupe_key_unique` ON `outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `outbox_status_next_idx` ON `outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`name` text PRIMARY KEY NOT NULL,
	`interval_seconds` integer NOT NULL,
	`next_run_at` integer NOT NULL,
	`locked_at` integer,
	`last_started_at` integer,
	`last_finished_at` integer,
	`last_status` text,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`filename` text NOT NULL,
	`mode` text NOT NULL,
	`total_rows` integer NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL,
	`failed` integer NOT NULL,
	`errors` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "import_runs_mode_check" CHECK(mode in ('dry_run', 'commit'))
);
