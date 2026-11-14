# 08 — Volunteer and Shift Scheduler

## 1. Purpose

A scheduling tool for one nonprofit: coordinators define one-off and recurring shifts, volunteers sign up within capacity limits, and the system sends email and SMS confirmations, reminders and cancellation notices. Volunteers can be bulk-imported from CSV and rosters exported. Read `../CONVENTIONS.md` first.

## 2. Stack and fixed decisions

| Concern | Choice |
|---|---|
| Runtime | Node 22, TypeScript 5.7 (`strict`) |
| Web | `@sveltejs/kit` 2.15.0, `svelte` 5.16.0 (runes), `@sveltejs/adapter-node` 5.2.11, Vite 6.0.5. Form actions with progressive enhancement (`use:enhance`); `+server.ts` endpoints only for CSV downloads and the health check |
| DB | SQLite via `better-sqlite3` 11.7.0 and `drizzle-orm` 0.38.3 (`drizzle-orm/better-sqlite3`), drizzle-kit 0.30.1. Migrations as SQL in `drizzle/` with `meta/_journal.json`, applied by `scripts/migrate.ts`. Pragmas on every connection: `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = NORMAL` |
| Worker | Separate process `src/worker/main.ts` (tsx 4.19.2) opening the same database file |
| Time | Luxon 3.5.0. Organisation zone from env `ORG_TIMEZONE` (default `America/New_York`) |
| Validation | zod 3.24.1 |
| Logging | pino 9.6.0 |
| Tests | Vitest 2.1.8; integration tests use a temp-file database per test file; concurrency tests spawn `worker_threads` or child processes opening the same file |
| Auth | Email + password (`crypto.scrypt`); opaque session token in cookie `vs_session`, SHA-256 stored; `hooks.server.ts` loads the user into `event.locals`. SvelteKit's built-in origin check provides CSRF protection (`csrf.checkOrigin` left enabled) |
| Providers | `EmailProvider` and `SmsProvider` interfaces (`send(message, { idempotencyKey }) → { providerMessageId }`, throwing `TransientProviderError` or `PermanentProviderError`); console implementations for dev; recording fakes for tests |

Layout: `src/lib/server/{db,auth,domain,services,outbox,csv,jobs}`, `src/lib/domain` (pure, shared: recurrence, time), `src/routes`, `src/worker`. Instants are stored as integer epoch milliseconds; civil dates as `YYYY-MM-DD` text; wall times as `HH:MM` text. Ids are UUID text.

All multi-statement writes use `db.transaction(fn, { behavior: "immediate" })` (i.e. `BEGIN IMMEDIATE`). Transactions are synchronous; no `await` inside a transaction callback.

## 3. Roles and permissions

| Action | volunteer | coordinator | admin |
|---|---|---|---|
| View upcoming shifts, own signups; edit own profile and notification preferences | yes | yes | yes |
| Sign up / cancel own signup | yes | yes | yes |
| Create/edit/cancel shifts and series, add exceptions | no | yes | yes |
| View rosters, add/remove any volunteer's signup, mark attendance | no | yes | yes |
| CSV import of volunteers, CSV exports | no | yes | yes |
| View outbox and job status, retry dead notifications | no | no | yes |
| Manage users and roles | no | no | yes |

Every form action and endpoint checks the role itself via `requireRole(event, …)`; `load` guards alone are not relied on. Volunteers requesting another user's signup get 404.

## 4. Domain model

- **users**: `id`, `email` (unique, lower-case), `name`, `phone?` (E.164), `passwordHash?` (null for imported users until they set one via an invite token), `role`, `emailOptIn` (default true), `smsOptIn` (default false), `active`.
- **sessions**: `id`, `userId`, `tokenHash`, `expiresAt`. **invite_tokens**: `tokenHash`, `userId`, `expiresAt`, `usedAt?`.
- **shift_series**: `id`, `title`, `location`, `description`, `startTime` (`HH:MM` org wall time), `durationMinutes` (15–720), `capacity` (1–500), `freq` (`DAILY` | `WEEKLY` | `MONTHLY`), `interval` (1–52), `byWeekday` (JSON array of `MO…SU`; WEEKLY only, non-empty), `byMonthDay` (1–31 or −1 = last day; MONTHLY only), `dtstart` (civil date), `until?` (civil date, inclusive), `count?` (1–500); at most one of `until`/`count`. `materializedThrough?` (civil date).
- **series_exceptions**: `id`, `seriesId`, `occurrenceDate`, `kind` (`cancelled` | `modified`), overrides `startTime?`, `durationMinutes?`, `capacity?`, `location?`. Unique `(seriesId, occurrenceDate)`.
- **shifts** (concrete occurrences and one-offs): `id`, `seriesId?`, `occurrenceDate?` (the date in the series' pattern, unchanged even if the time is moved), `title`, `location`, `startsAt`, `endsAt`, `capacity`, `status` (`scheduled` | `cancelled`), `detached` (bool: has a `modified` exception). Unique `(seriesId, occurrenceDate)`. Check `endsAt > startsAt`.
- **signups**: `id`, `shiftId`, `userId`, `status` (`confirmed` | `waitlisted` | `cancelled`), `waitlistSeq?` (int, per shift, monotonically increasing), `attended?` (bool), `createdAt`, `cancelledAt?`. Partial unique index `(shiftId, userId) WHERE status != 'cancelled'`.
- **outbox**: `id`, `dedupeKey` (unique), `channel` (`email` | `sms`), `userId`, `template`, `payload` (JSON), `status` (`pending` | `sending` | `sent` | `skipped` | `failed` | `dead`), `attempts`, `nextAttemptAt`, `lockedAt?`, `providerMessageId?`, `lastError?`, `createdAt`, `sentAt?`.
- **jobs**: `name` (PK; `materialize`, `reminders`, `cleanup`), `intervalSeconds`, `nextRunAt`, `lockedAt?`, `lastStartedAt?`, `lastFinishedAt?`, `lastStatus?`, `lastError?`, `consecutiveFailures`.
- **import_runs**: `id`, `userId`, `filename`, `mode` (`dry_run` | `commit`), `totalRows`, `created`, `updated`, `failed`, `errors` (JSON), `createdAt`.

## 5. Domain rules

### 5.1 Recurrence

`occurrences(series, rangeStart, rangeEnd)` is a pure function returning civil dates in `[rangeStart, rangeEnd]` (inclusive civil dates).

- `DAILY`: `dtstart + k × interval` days.
- `WEEKLY`: weeks start on Monday. Week index = number of whole weeks between the Monday of `dtstart`'s week and the Monday of the candidate's week; a candidate is included when `weekIndex % interval == 0`, its weekday is in `byWeekday`, and it is `>= dtstart`. `dtstart` itself is an occurrence only if its weekday is in `byWeekday`.
- `MONTHLY`: every `interval` months counted from `dtstart`'s month. Day = `byMonthDay`; if the month has no such day the month is **skipped** (no clamping). `−1` = last day of the month. Candidates before `dtstart` are excluded.
- `until`: last allowed occurrence date, inclusive. `count`: the first `count` dates the rule generates from `dtstart`, counted **before** exceptions (a cancelled occurrence still consumes one).
- A hard cap of 1,000 generated candidates per call prevents unbounded iteration.
- Exceptions: `cancelled` removes the occurrence; `modified` keeps the `occurrenceDate` and overrides fields.
- Wall time to instant in `ORG_TIMEZONE` for date D and `startTime`: normal → that instant; non-existent (spring-forward gap) → shifted forward by the gap length (02:30 becomes 03:30); ambiguous (fall-back) → the earlier instant. `endsAt = startsAt + durationMinutes` of elapsed time. Implemented explicitly in `src/lib/domain/time.ts`.

### 5.2 Materialisation

Shifts for a series are stored rows, created for a rolling horizon of 60 days (org-zone dates, `today … today + 60`).

- On series create/update and in the `materialize` job: compute occurrences in the horizon, apply exceptions, and `INSERT … ON CONFLICT (seriesId, occurrenceDate) DO NOTHING`; then set `materializedThrough`. Re-running creates nothing new.
- Occurrences with a `cancelled` exception are never inserted (or, if already present, are cancelled per 5.4).
- Series edit ("this and following", effective from date E). E must lie within the materialisation horizon, `today <= E <= today + 60` (org-zone dates); anything else is `422 invalid_effective_date`. The edit first materialises the series' current pattern through the horizon and then applies the changes from E, in one transaction. A series holds one pattern at a time, so this ordering is what guarantees that every stored date before E follows the old pattern and every date generated later (on or after E, including beyond the horizon) follows the new one.
  - Field changes (title, location, time, duration, capacity) are applied to that series' future shifts with `occurrenceDate >= E`, `status = 'scheduled'`, `detached = false`, and `startsAt > now`. Detached shifts keep their overrides.
  - If the recurrence pattern changes, shifts with `occurrenceDate >= E` no longer in the pattern are cancelled (5.4), and missing ones are inserted.
  - Lowering capacity below a shift's confirmed count does not remove anyone; the shift is shown as over capacity and takes no new signups.
  - If a time change alters `startsAt`, confirmed and waitlisted volunteers get a `shift-changed` notification (dedupe key includes the new `startsAt`).
- Deleting a series cancels all its future scheduled shifts (5.4) and sets `until` to yesterday; past shifts remain.

### 5.3 Signups

`signUp(userId, shiftId, actor)` in one immediate transaction:

1. Shift exists and is `scheduled` (`shift_cancelled`), `now < startsAt` (`shift_started`).
2. User has no active signup for the shift (`already_signed_up`; the partial unique index is the backstop and maps to the same error).
3. User has no other `confirmed` signup on a `scheduled` shift whose `[startsAt, endsAt)` overlaps this one (`overlapping_shift`). Waitlisted signups are not checked.
4. Count `confirmed` signups for the shift inside the transaction. If `< capacity` → `confirmed`; else → `waitlisted` with `waitlistSeq = max(waitlistSeq for shift) + 1`.
5. Insert the outbox rows (5.5) in the same transaction.

`cancelSignup(signupId, actor)` in one immediate transaction:

- Volunteers may cancel their own signup until `startsAt − 2 h` (exactly 2 h before is allowed); later → `cancellation_closed`. Coordinators may remove anyone until `endsAt`.
- Set `cancelled`. If it was `confirmed`, promote: take waitlisted signups in `waitlistSeq` order; the first whose user has no overlapping confirmed shift becomes `confirmed` (others are left in place); enqueue `waitlist-promoted` for them. Promotion happens only while `confirmed count < capacity`.
- Cancelling an already cancelled signup is a no-op returning success.

Capacity increases (shift edit) promote as many waitlisted signups as now fit, in the same transaction.

### 5.4 Shift cancellation

Cancelling a shift (directly, via exception, or via series change) in one transaction: `status = 'cancelled'`; every `confirmed` and `waitlisted` signup → `cancelled`; one `shift-cancelled` outbox row per affected user and enabled channel. Cancelling an already cancelled shift is a no-op. Pending reminder rows for that shift are left in place and are skipped at send time (5.5).

### 5.5 Notifications (outbox)

A notification is created only by inserting an outbox row inside the same transaction as the state change that causes it. Nothing calls a provider from a request handler.

- One row per (event, user, channel). Channels: email if `emailOptIn`; SMS if `smsOptIn` and `phone` is set. Preferences are evaluated when the row is created.
- Insert is `INSERT … ON CONFLICT (dedupeKey) DO NOTHING`. Dedupe keys:
  - `signup-confirmed:<signupId>:<channel>`
  - `signup-waitlisted:<signupId>:<channel>`
  - `waitlist-promoted:<signupId>:<channel>`
  - `signup-cancelled:<signupId>:<channel>` (only when a coordinator removes a volunteer)
  - `shift-cancelled:<shiftId>:<userId>:<channel>`
  - `shift-changed:<shiftId>:<startsAtMs>:<userId>:<channel>`
  - `reminder-24h:<shiftId>:<userId>:<channel>`
- The payload stores ids, not rendered text; the message is rendered at send time from current data, with times formatted in `ORG_TIMEZONE`.

Dispatcher (worker loop, every 5 s):

1. **Claim**, in one immediate transaction: select up to 20 rows with `status = 'pending' AND nextAttemptAt <= now` ordered by `nextAttemptAt, id`, set `status = 'sending'`, `lockedAt = now`, `attempts = attempts + 1`. Also, rows in `sending` with `lockedAt < now − 5 min` are returned to `pending` (without changing `attempts`) before selecting.
2. **Validate** each claimed row against current state before sending; if no longer relevant set `skipped`:
   - reminders: signup must still be `confirmed`, shift `scheduled`, and `now < startsAt`;
   - `signup-confirmed` / `waitlist-promoted` / `signup-waitlisted`: signup must still be in the corresponding status;
   - user must be active and still opted in to the channel (SMS also requires a phone).
3. **Quiet hours** (SMS only): if org-local time is in `[21:00, 08:00)`, set back to `pending` with `nextAttemptAt` = next 08:00 org time and decrement `attempts` (a deferral is not an attempt). Reminders that would then be after `startsAt` are skipped by rule 2 when retried.
4. **Send** with `idempotencyKey = dedupeKey`. Provider calls happen outside any transaction.
5. **Record**, with an update conditional on `status = 'sending' AND id = ?`:
   - success → `sent`, `sentAt`, `providerMessageId`;
   - `PermanentProviderError` → `failed` (no retry);
   - `TransientProviderError` or any other error → if `attempts >= 5` → `dead`; else `pending` with `nextAttemptAt = now + backoff(attempts)` where backoff is 1 min, 5 min, 25 min, 2 h for attempts 1–4.

Guarantee: each dedupe key produces at most one outbox row; each row is delivered at-least-once to the provider, with the same idempotency key on every attempt so that a provider honouring the key delivers once. A crash between a successful send and recording it results in a re-send with the same key after the 5-minute lock expiry.

Admins can retry a `dead` row (→ `pending`, `attempts = 0`, `nextAttemptAt = now`).

### 5.6 CSV import and export

Parser (`src/lib/server/csv/parse.ts`, hand-written, no library), RFC 4180 with these specifics:

- Input decoded as UTF-8; a leading BOM is stripped. Invalid UTF-8 → file-level error.
- Record separators: CRLF, LF, or lone CR. A final record without a trailing newline is accepted. Completely empty lines are skipped (and not counted as rows).
- Fields may be quoted with `"`; inside quotes `""` is a literal quote, and commas and newlines are data. Characters after a closing quote other than a comma or record end → row error `malformed_quotes`. An unterminated quote at end of file → file-level error naming the line where the quote opened.
- Unquoted fields are trimmed of surrounding spaces and tabs; quoted fields are kept verbatim.
- Each record carries `rowNumber` (1-based data record index, header excluded) and `line` (physical line where the record starts).
- Limits: 2 MiB, 5,000 data rows (`file_too_large`, `too_many_rows`; nothing imported).

Volunteer import (`name,email,phone,role,sms_opt_in`):

- Header row required; names matched case-insensitively after trimming; `name` and `email` columns required (missing → file-level error `missing_columns`); unknown columns ignored with a warning; duplicate header names → file-level error.
- A record with a different number of fields than the header → row error `wrong_field_count`.
- Row validation: `name` 1–120 chars; `email` valid and lower-cased; `phone` optional, normalised to E.164 (digits with optional leading `+`; 10 digits → `+1…`; 11 digits starting with 1 → `+…`; anything else → `invalid_phone`); `role` optional, only `volunteer` or `coordinator` (default `volunteer`; `admin` not importable → `invalid_role`); `sms_opt_in` optional `true/false/yes/no/1/0` case-insensitive (default false; true without a phone → `sms_requires_phone`).
- Duplicate email within the file: the first occurrence is used; later ones are row errors `duplicate_in_file` referencing the first row number.
- Existing user with that email: `name`, `phone`, `sms_opt_in` updated; `role` is never changed by import; an existing admin is never modified (`protected_user`).
- Modes: `dry_run` validates and reports only. `commit` applies all valid rows in a single immediate transaction and reports invalid ones; if the transaction fails, nothing is imported. The same report shape is returned for both: `{ totalRows, created, updated, failed, warnings: [...], errors: [{ rowNumber, line, column?, code, message }] }`, and saved in `import_runs`.
- New users get no password; an invite link (single-use token, 7-day expiry) is shown to the coordinator in the report. No notification is sent by import.

Exports (`text/csv; charset=utf-8`, `Content-Disposition: attachment`):

- Shift roster (`/shifts/[id]/roster.csv`) and signups in a date range (`/exports/signups.csv?from=&to=`, org-local dates, inclusive, max 366 days).
- Output: UTF-8 with BOM, CRLF records, fields quoted when they contain `"`, comma, CR or LF, with quotes doubled. Cells whose first character is `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`. Timestamps are ISO-8601 with the org zone's offset. Phone numbers are emitted as text (the `+` prefix rule applies).
- Export output parsed by the import parser yields the same field values (round-trip, modulo the `'` prefix).

## 6. Routes

| Route | Notes |
|---|---|
| `/login`, `/logout`, `/invite/[token]` | Invite sets a password; token single-use |
| `/` | Upcoming shifts (next 60 days) grouped by org-local date, with remaining capacity and own status; actions `signup`, `cancel` |
| `/my` | Own signups and waitlist positions; `/my/profile` name, phone, preferences |
| `/manage/shifts` | List with filters; create one-off shift |
| `/manage/shifts/[id]` | Edit (title, location, time, capacity), cancel, roster with add/remove volunteer, attendance (only after `startsAt`) |
| `/manage/series`, `/manage/series/new`, `/manage/series/[id]` | Create/edit with effective date, preview of next 10 occurrences computed by the same recurrence function, exceptions (cancel/modify one occurrence), delete |
| `/manage/volunteers` | List, search; `/manage/volunteers/import` upload with `mode`, renders the report |
| `/shifts/[id]/roster.csv`, `/exports/signups.csv` | `+server.ts`, coordinator |
| `/admin/outbox` | Filter by status; retry dead |
| `/admin/jobs` | Job table |
| `/admin/users` | Roles, activation |
| `/api/health` | JSON |

Form actions return `fail(status, { error: { code, message, details }, values })` on failure; pages render the message and field errors. `+server.ts` endpoints use the JSON envelope.

## 7. Background jobs

The worker runs two loops and shuts down gracefully on SIGTERM (finishes the current batch).

**Outbox dispatcher**: 5.5.

**Scheduled jobs** (every 30 s check): for each row in `jobs` with `nextRunAt <= now` and (`lockedAt` null or older than 10 min), claim it in an immediate transaction (set `lockedAt`, `lastStartedAt`), run the handler, then record `lastFinishedAt`, `lastStatus`, clear `lockedAt`, and set `nextRunAt = now + intervalSeconds`. On error: record `lastError`, increment `consecutiveFailures`, set `nextRunAt = now + min(intervalSeconds, 60 × 2^consecutiveFailures)` seconds; success resets the counter. A handler exception never stops the loop.

| Job | Interval | Handler |
|---|---|---|
| `materialize` | 6 h | 5.2 for every series; each series in its own transaction; one series failing is logged and the rest continue, and the job is recorded as failed |
| `reminders` | 5 min | For shifts `scheduled` with `startsAt` in `(now + 2 h, now + 24 h]`, insert `reminder-24h` rows for every `confirmed` signup (the dedupe key makes repeats harmless). A volunteer confirmed less than 24 h before the shift gets the reminder at the next run; one confirmed 2 h or less before the shift gets none |
| `cleanup` | 24 h | Delete expired sessions and invite tokens; delete `sent`/`skipped` outbox rows older than 90 days |

Failure modes that must be handled: worker crash mid-dispatch (lock expiry), crash mid-job (lock expiry, handlers idempotent), two workers started by mistake (claims are transactional; no double processing beyond the documented at-least-once), `SQLITE_BUSY` (busy timeout, and the dispatcher treats it as a skipped tick, logged at warn), provider outage (backoff then `dead`), malformed outbox payload (→ `failed` with error, does not block the batch).

## 8. Edge cases

1. Weekly, interval 2, `byWeekday = [MO, TH]`, `dtstart` on a Wednesday: first occurrence is that week's Thursday; the following week is skipped; then Monday and Thursday of the week after.
2. Weekly series whose `dtstart` weekday is not in `byWeekday`: `dtstart` is not an occurrence.
3. Monthly on day 31: only months with 31 days. Monthly on −1: Jan 31, Feb 28/29, Mar 31, Apr 30.
4. Monthly on day 29, interval 1, across a non-leap February: February skipped.
5. `count = 5` with the 2nd occurrence cancelled by exception: four shifts exist; no sixth date is generated.
6. `until` equal to an occurrence date includes it.
7. Daily 02:30 series across spring-forward: that day's shift starts at 03:30 local; other days at 02:30. Across fall-back, 01:30 uses the first 01:30; duration is elapsed time.
8. Shift at 23:30 for 90 minutes ends the next day; it is listed under its start date; overlap checks use instants.
9. Materialisation run twice, or concurrently by request and worker, creates each occurrence once.
10. Series time edit effective from E: shifts before E, already started, or detached are unchanged.
11. Pattern change removing Thursdays: future Thursday shifts with signups are cancelled and those volunteers notified once.
12. A `modified` exception moving one occurrence to another time keeps its `occurrenceDate`; re-materialisation does not recreate the original.
13. Two volunteers taking the last spot at the same time (separate processes): one `confirmed`, one `waitlisted`; confirmed count never exceeds capacity.
14. Same volunteer double-clicking sign up: one signup, one confirmation notification.
15. Sign-up at exactly `startsAt` is refused.
16. Volunteer cancel at exactly `startsAt − 2 h` allowed; one second later refused; coordinator still allowed.
17. Cancel by a confirmed volunteer promotes the lowest `waitlistSeq`; if that user has an overlapping confirmed shift, the next eligible is promoted and the first stays waitlisted.
18. Cancel by a waitlisted volunteer promotes no one.
19. Re-signing up after cancelling creates a new signup row with a new waitlist position and new dedupe keys.
20. Adjacent shifts (one ends when the other starts) are not overlapping.
21. Capacity raised by 2 with 3 waitlisted: first two promoted. Capacity lowered below confirmed: nobody removed, no new signups, promotions suspended.
22. Shift cancelled: all signups cancelled, exactly one notice per user per channel, even if the cancel action is submitted twice.
23. `reminders` job running every 5 minutes creates one reminder row per signup per channel in total.
24. Volunteer cancels after the reminder row was created and before it is sent: row becomes `skipped`.
25. Reminder for a shift that has started by the time it is processed (e.g. after an outage or quiet hours) is `skipped`.
26. User turns off SMS after a row was created: row `skipped` at send time.
27. Provider transient failures: attempts at +1 min, +5 min, +25 min, +2 h, then `dead` after the fifth failure; every attempt uses the same idempotency key.
28. Permanent failure (invalid number): `failed` after one attempt.
29. Worker killed after the provider accepted a message and before `sent` was written: row is retried after 5 minutes with the same key; `attempts` is not double-counted by the lock reset.
30. Two workers running: no row is claimed by both in the same lock window.
31. SMS created at 22:00 org time is deferred to 08:00 and the deferral does not consume an attempt; email is sent immediately.
32. One outbox row with a corrupt payload does not prevent the rest of the batch from sending.
33. CSV with BOM, CRLF, quoted field containing a comma, a newline and `""` parses correctly, and `line` numbers after the multi-line field are still correct.
34. CSV: unterminated quote → file-level error with the opening line; `"abc"def` → row error; row with too few or too many fields → row error; blank lines ignored; file with only a header → zero rows, no error; empty file → `missing_header`.
35. CSV: headers ` Email `, `NAME` accepted; missing `email` column → file-level error; duplicate `email` header → file-level error.
36. CSV: same email twice with different case → second is `duplicate_in_file`; existing user updated without role change; existing admin untouched with `protected_user`.
37. CSV: commit with 3 bad rows out of 100 imports 97 and reports 3 with row numbers; dry run of the same file changes nothing and reports the same counts.
38. CSV: phone `(555) 010-1234` → `+15550101234`; `12345` → `invalid_phone`.
39. Export: a volunteer named `=HYPERLINK("x")` is emitted as `'=HYPERLINK("x")` correctly quoted; names with commas, quotes and newlines round-trip through the parser.
40. Export date range uses org-local days: a shift at 23:30 local on the `to` date is included; one at 00:00 the next day is not.
41. Volunteer invoking a manage action directly (crafted POST) → 403; requesting another user's signup id → 404.
42. Invite token reuse or expiry → rejected; setting a password invalidates the token.
43. Series edit with an effective date before today or more than 60 days ahead → `invalid_effective_date`, nothing changed.
44. Weekly Monday series edited to Wednesdays effective three weeks from now: the Mondays of the next three weeks remain scheduled, later Mondays inside the horizon are cancelled, Wednesdays are created from the effective date, and occurrences materialised on later days are Wednesdays only.

## 9. Non-goals

Multiple organisations, shift swaps between volunteers, hour tracking reports, calendar feeds (iCal), real SMS/email providers, inbound SMS (STOP handling), full RFC 5545 (no BYSETPOS, YEARLY, RDATE, per-series time zones), CSV import of shifts, i18n, rate limiting.

## 10. Acceptance criteria

- Recurrence output matches 5.1 for every listed case, and materialisation is idempotent.
- Confirmed signups never exceed capacity (other than by explicit capacity reduction), under concurrent sign-ups from separate processes.
- No notification is created twice for the same event, and the dispatcher's retry, skip, defer and dead-letter behaviour matches 5.5.
- CSV import reports precise row-level errors and never partially applies a row; exports are safe to open in spreadsheet software and round-trip.
- Job and dispatcher loops survive every failure mode listed in section 7.
- All edge cases in section 8 hold.

## 11. Required tests

Unit:
- Recurrence: each frequency, interval, weekday sets, month-day skipping, −1, `count` vs exceptions, `until` inclusive, range clipping, candidate cap.
- Wall-time resolution on gap and overlap days; elapsed-time durations.
- CSV parser: every rule in 5.6 (BOM, separators, quoting, malformed quotes, unterminated quote, blank lines, row/line numbering with embedded newlines, limits).
- CSV writer: quoting, formula guard, BOM/CRLF; parser round-trip property over a table of awkward values.
- Phone normalisation; boolean parsing.
- Backoff schedule; quiet-hours next-08:00 computation including across a DST change.

Integration (temp SQLite file):
- Materialisation idempotence; series edit effective date including the allowed range and old-pattern dates before it; pattern change cancellations; detached shifts preserved.
- Sign-up: capacity, waitlist ordering, overlap rule, cut-offs at boundaries, re-signup.
- Concurrent sign-ups for the last spot from two processes/threads.
- Cancel and promotion rules; capacity increase/decrease.
- Shift cancellation notifications exactly once (double submit).
- Outbox: dedupe on insert; claim exclusivity with two dispatchers; validation skips; quiet-hours deferral; transient retry sequence to `dead`; permanent failure; stale lock recovery without attempt inflation; idempotency key constant across attempts; corrupt payload isolation.
- Reminders job repeat runs create one row; late confirmations.
- Job runner: lock, failure backoff, recovery from stale lock, loop continues after handler error.
- Import: dry run vs commit, each row error code, duplicates, protected users, transactional failure imports nothing, report persisted.
- Role enforcement on form actions and endpoints (direct invocation), 404 for foreign signups.

## 12. Commit plan

1. `chore`: scaffold (SvelteKit config, tsconfig, lint, env module, logger, `.env.example`).
2. `feat`: Drizzle schema, migrations, connection setup with pragmas, migrate script.
3. `feat`: auth — sessions, hooks, login, invites, role guard, user admin.
4. `feat`: recurrence and time domain modules with unit tests.
5. `feat`: shifts and series — services, materialisation, exceptions, series edits, coordinator screens.
6. `feat`: sign-ups — capacity, waitlist, cancellation, promotion, volunteer screens.
7. `feat`: outbox — enqueue helpers wired into signup/shift services, provider interfaces, dispatcher.
8. `feat`: worker — job runner, materialize/reminders/cleanup jobs, admin outbox and jobs screens.
9. `feat`: CSV parser and writer with unit tests.
10. `feat`: volunteer import (dry run/commit, report) and exports.
11. `test`: concurrency and failure-mode integration suites.
12. `docs`/`ci`: seed script, README, CI workflow.
