# 01 — Clinic Booking

## 1. Purpose

A booking system for a small group of clinics. Staff define when providers work; patients book, reschedule and cancel appointments online; the system emails reminders. Read `../CONVENTIONS.md` first.

## 2. Stack and fixed decisions

| Concern | Choice |
|---|---|
| Runtime | Node 22, TypeScript 5.7 (`strict`) |
| Web | Next.js 15.1.3 App Router, React 19.0.0. `params`, `searchParams`, `cookies()` and `headers()` are async in this version |
| DB | PostgreSQL 16 (compose host port 5451), Prisma 6.1.0 (`prisma` + `@prisma/client`) |
| Jobs | pg-boss 10.1.5, separate worker process `src/worker/index.ts` run with `tsx` 4.19.2. In v10 queues must be created with `createQueue` and `work` handlers receive an array of jobs |
| Time | Luxon 3.5.0 (`@types/luxon` 3.4.2). No `Date` arithmetic in domain code |
| Validation | zod 3.24.1 |
| Logging | pino 9.6.0 |
| Tests | Vitest 2.1.8; integration tests hit a real Postgres |
| Auth | Email + password (Node `crypto.scrypt`, per-user salt). Opaque session token in cookie `cb_session`; SHA-256 of the token stored in `Session`. 14-day expiry |
| CSRF | Mutating route handlers require `Content-Type: application/json` and an `Origin` header matching `APP_ORIGIN`; server actions rely on Next's built-in origin check |
| Email | `Mailer` interface; `ConsoleMailer` in dev; `MemoryMailer` in tests |

Layout: `src/app` (pages + `api` route handlers), `src/domain` (pure logic: time, slots, policies), `src/services` (transactions), `src/server` (auth, errors, logging, env), `src/worker`, `prisma/`.

Pages are server components that call services directly. Mutations from the UI go through the JSON API with `fetch` from small client components (no server actions for booking flows, so all business errors travel through one envelope).

## 3. Roles and permissions

`PATIENT` (self-registers), `PROVIDER`, `STAFF`, `ADMIN`. `PROVIDER` and `STAFF` belong to exactly one clinic; `ADMIN` is global.

| Action | PATIENT | PROVIDER | STAFF | ADMIN |
|---|---|---|---|---|
| View clinics, providers, open slots | yes | yes | yes | yes |
| Book for self | yes | no | no | no |
| Book on behalf of a patient | no | no | own clinic | yes |
| View an appointment | own | where they are the provider | own clinic | yes |
| Cancel / reschedule | own, subject to the 24 h rule | no | own clinic | yes |
| Mark `COMPLETED` / `NO_SHOW` | no | own appointments | own clinic | yes |
| Manage availability rules and exceptions | no | own (read only) | own clinic | yes |
| Manage providers, clinics, staff accounts | no | no | no | yes |

A request for an appointment the caller may not view returns `404 not_found`. Role failures on collection or management endpoints return `403 forbidden`.

## 4. Domain model

- **Clinic**: `id`, `name`, `timezone` (IANA, validated against Luxon), `minLeadMinutes` (default 60), `bookingHorizonDays` (default 90).
- **User**: `id`, `email` (unique, stored lower-case), `passwordHash`, `role`, `clinicId?`.
- **Session**: `id`, `userId`, `tokenHash` (unique), `expiresAt`.
- **Patient**: `id`, `userId` (unique), `fullName`, `phone?`, `timezone` (IANA; default is the browser zone sent at registration).
- **Provider**: `id`, `userId` (unique), `clinicId`, `displayName`, `specialty`, `active`.
- **AvailabilityRule**: `id`, `providerId`, `weekday` (1 = Monday … 7 = Sunday, ISO), `startLocal`, `endLocal` (`HH:MM`, clinic wall time, `startLocal < endLocal`, no crossing midnight), `slotMinutes` (15, 20, 30, 45 or 60), `validFrom` (date), `validTo?` (date, inclusive). Rules for the same provider and weekday must not overlap in wall time on any date where both are valid.
- **AvailabilityException**: `id`, `providerId`, `localDate`, `kind` (`CLOSED` | `CUSTOM_HOURS`), `startLocal?`, `endLocal?`, `slotMinutes?`. Unique `(providerId, localDate)`.
- **Appointment**: `id`, `providerId`, `patientId`, `startsAt`, `endsAt` (timestamptz), `status` (`BOOKED` | `CANCELLED` | `COMPLETED` | `NO_SHOW`), `reason?` (max 500), `bookedByUserId`, `cancelledAt?`, `cancelledByUserId?`, `cancelReason?`, `lateCancel` (bool), `rescheduledFromId?`, `idempotencyKey?`, `createdAt`.
- **Reminder**: `id`, `appointmentId`, `kind` (`T24H` | `T2H`), `scheduledFor`, `status` (`PENDING` | `SENDING` | `SENT` | `SKIPPED` | `FAILED`), `attempts`, `claimedAt?`, `sentAt?`, `lastError?`. Unique `(appointmentId, kind)`.

- **AppointmentNotification** (table `appointment_notifications`): `id`, `appointmentId`, `kind` (`CANCELLATION` | `RESCHEDULED`), `status` (same values as Reminder), `attempts`, `claimedAt?`, `sentAt?`, `lastError?`, `createdAt`. Unique `(appointmentId, kind)`. A `RESCHEDULED` row belongs to the new appointment.

Database invariants (written as raw SQL in the Prisma migration; requires `CREATE EXTENSION btree_gist`):

- `CHECK (ends_at > starts_at)`.
- `EXCLUDE USING gist (provider_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status = 'BOOKED')`.
- The same exclusion keyed on `patient_id`.
- Unique `(patient_id, idempotency_key)` where the key is not null.

## 5. Domain rules

### 5.1 Time

- All instants are UTC in the database and in JSON. The clinic's zone governs everything about availability, "today", lead time, horizon, and day views. The patient's zone is used only for display and reminder text.
- Every range is half-open `[start, end)`. Two appointments where one ends exactly when the other starts do not overlap.
- The local day `D` in zone `Z` is `[startOfDay(D, Z), startOfDay(D + 1, Z))`. It is 23 or 25 hours long on DST transition days. Any query "appointments on day D" filters `startsAt >= dayStart AND startsAt < dayEnd`.
- Wall time to instant (`resolveLocal(date, "HH:MM", zone)`), implemented explicitly rather than relying on library defaults:
  - Normal time: the single matching instant.
  - Non-existent time (spring-forward gap): returns `null`.
  - Ambiguous time (fall-back overlap): the earlier instant (the first occurrence).

### 5.2 Slot generation

Slots are computed, never stored. For provider `P` and local date `D`:

1. If an exception exists for `(P, D)`: `CLOSED` yields no slots; `CUSTOM_HOURS` replaces all rules for that date with one window using the exception's hours and `slotMinutes`.
2. Otherwise take every rule where `weekday = isoWeekday(D)` and `validFrom <= D` and (`validTo` is null or `D <= validTo`).
3. For each window, candidate wall-clock starts are `startLocal + k * slotMinutes` for `k >= 0` while `candidate + slotMinutes <= endLocal` (wall-clock arithmetic). A trailing remainder shorter than a slot is not offered.
4. Each candidate is resolved with `resolveLocal`. A `null` result is dropped. `endsAt = startsAt + slotMinutes` of elapsed time.
5. If, after resolution, a slot's `startsAt` is earlier than the previous slot's `endsAt` in the same window, the slot is dropped.
6. A slot is `available` when no `BOOKED` appointment of that provider overlaps it, `startsAt >= now + minLeadMinutes`, and the slot's local date is `<= today(Z) + bookingHorizonDays`. Otherwise it is returned with `available: false` and a `reason` of `booked`, `too_soon` or `beyond_horizon`. Patients never see who booked a slot.

Inactive providers have no slots.

### 5.3 Booking

Input: `providerId`, `startsAt` (instant), optional `reason`, optional `patientId` (staff/admin only; patients always book for themselves), optional `Idempotency-Key` header (1–64 chars).

Checks, all inside one transaction:

1. Provider exists and is active (else `404`). Staff may only book within their clinic.
2. `startsAt` equals the start of a generated slot for the slot's local date in the clinic zone (else `422 not_a_slot`). `endsAt` comes from the slot, never from the client.
3. Lead time and horizon as in 5.2 step 6 (`422 too_soon`, `422 beyond_horizon`). Staff and admin are exempt from lead time but not from "start is in the future" (`422 in_past`).
4. The patient has no other `BOOKED` appointment with this provider whose start falls on the same clinic-local day (`422 daily_limit`).
5. Insert. A provider exclusion violation maps to `409 slot_taken`; a patient exclusion violation maps to `409 patient_conflict`. Distinguish by constraint name.
6. Insert reminders (5.6) in the same transaction.

Idempotency: when a key is supplied and an appointment already exists for `(patientId, key)`, return that appointment with `200` if `providerId` and `startsAt` match, otherwise `422 idempotency_key_reused`. Two concurrent requests with the same key produce one appointment; the loser of the unique-constraint race returns the winner's row.

### 5.4 Cancellation

- Only `BOOKED` appointments can be cancelled; any other status returns `409 invalid_state`.
- Patient: allowed when `startsAt - now >= 24 h` (exactly 24 h is allowed), else `422 cancellation_window_closed`.
- Staff/admin: allowed any time before `startsAt`; `lateCancel = true` when `startsAt - now < 24 h`. After `startsAt`, cancellation is refused (`422 already_started`); use `NO_SHOW`.
- The update is conditional on `status = 'BOOKED'`; zero rows updated means a concurrent change, returned as `409 invalid_state`.
- Pending reminders for the appointment become `SKIPPED` in the same transaction. A `CANCELLATION` row is inserted into `appointment_notifications` in that transaction too; the worker sends the cancellation email from it (section 7). Nothing is enqueued from the request.
- A cancelled slot is immediately bookable again.

### 5.5 Reschedule and completion

- Reschedule is one transaction: cancel the old appointment (as in 5.4, without sending the cancellation email), then validate and insert the new one as in 5.3 (same provider or a different provider in the same clinic) with `rescheduledFromId` set. Because the old row is cancelled first, it does not count in the new booking's patient-overlap and daily-limit checks. If anything fails, the whole transaction rolls back and the old appointment and its reminders are untouched. The transaction inserts one `RESCHEDULED` row into `appointment_notifications` for the new appointment (and no `CANCELLATION` row for the old one), so the patient gets a single "rescheduled" email.
- The patient's 24 h rule applies to the old appointment. Lead time applies to the new slot.
- `COMPLETED` / `NO_SHOW` can be set only from `BOOKED` and only when `now >= startsAt`. These states are terminal.

### 5.6 Reminders

- On booking, create `T24H` at `startsAt - 24 h` and `T2H` at `startsAt - 2 h`. A reminder whose `scheduledFor <= now` at booking time is not created.
- Reschedule creates reminders for the new appointment; the old ones are skipped by the cancellation.
- Email body shows the start in the patient's zone with zone abbreviation and, if the clinic's zone differs in offset at that instant, also in the clinic's zone. Formatting uses the instant and the zone, never a stored local string.

## 6. API surface

All under `/api`. JSON in and out, error envelope per CONVENTIONS. `401 unauthenticated` when no valid session.

| Method & path | Notes |
|---|---|
| `POST /auth/register` | Patient self-registration: `email`, `password` (min 10), `fullName`, `timezone` |
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | Login failure is always `401 invalid_credentials` |
| `GET /clinics`, `GET /clinics/:id/providers` | Active providers only for patients |
| `GET /providers/:id/slots?from=YYYY-MM-DD&to=YYYY-MM-DD` | Clinic-local dates, inclusive, max 31 days (`400` beyond). Returns `{ timezone, days: [{ date, slots: [{ startsAt, endsAt, available, reason? }] }] }` |
| `POST /appointments` | 5.3; `201` on create, `200` on idempotent replay |
| `GET /appointments?scope=mine\|clinic&date=YYYY-MM-DD&providerId=&status=` | `scope=clinic` is staff/admin/provider; `date` is a clinic-local day; providers only see their own |
| `GET /appointments/:id` | |
| `POST /appointments/:id/cancel` | body `{ reason? }` |
| `POST /appointments/:id/reschedule` | body `{ providerId?, startsAt }`; returns the new appointment |
| `POST /appointments/:id/complete`, `POST /appointments/:id/no-show` | |
| `GET/POST /providers/:id/availability-rules`, `PATCH/DELETE /availability-rules/:id` | Staff/admin. Overlapping rules → `422 rule_overlap` |
| `GET/POST /providers/:id/exceptions`, `DELETE /exceptions/:id` | Staff/admin |
| `GET/POST /admin/clinics`, `PATCH /admin/clinics/:id`, `GET/POST /admin/providers`, `PATCH /admin/providers/:id`, `POST /admin/staff` | Admin |

Changing rules or exceptions never alters existing appointments. The response to a rule/exception change includes `affectedAppointments`: ids of `BOOKED` appointments that no longer match a generated slot, for staff to handle manually.

Pages: `/login`, `/register`, `/book` (clinic → provider → day → slot), `/appointments` (patient list with cancel/reschedule), `/staff/day` (day view for a clinic-local date with provider columns), `/staff/providers/[id]/availability`, `/admin`.

The patient UI renders times in the patient's zone and labels the clinic's zone when offsets differ. The staff UI renders in the clinic's zone.

## 7. Background jobs

Worker process starts pg-boss, creates queues, registers handlers and a cron schedule.

| Queue | Trigger | Behaviour |
|---|---|---|
| `reminders.dispatch` | cron, every minute | Selects up to 100 `PENDING` reminders with `scheduledFor <= now`, ordered by `scheduledFor`, `FOR UPDATE SKIP LOCKED`; sets them to `SENDING` with `claimedAt = now`; enqueues one `reminders.send` per row with `singletonKey` = reminder id. Also resets `SENDING` rows whose `claimedAt` is older than 10 minutes back to `PENDING` |
| `reminders.send` | from dispatch | Loads reminder + appointment. If the reminder is not `SENDING`, exit. If the appointment is not `BOOKED`, or `scheduledFor` is more than 30 minutes in the past, or `now >= startsAt`: mark `SKIPPED`. Otherwise send; on success mark `SENT` with `sentAt` using a conditional update on `status = 'SENDING'` |
| `email.cancellation`, `email.rescheduled` | from dispatch | The same dispatch run also claims `PENDING` rows of `appointment_notifications` (`FOR UPDATE SKIP LOCKED`, set `SENDING`, reset claims older than 10 minutes) and enqueues one job per row on the queue for its kind. The handler exits unless the row is `SENDING`, sends the email (the rescheduled email names the previous time via `rescheduledFromId`), and marks it `SENT` with a conditional update. These emails are not subject to the staleness rule |

Failure semantics for `reminders.send`: on a mailer error, increment `attempts`, store `lastError`, set status back to `PENDING` if `attempts < 5` else `FAILED`. The handler does not throw for mailer errors (state is in the table); it throws only for unexpected errors so pg-boss retries. Delivery is at-least-once: a crash after the provider accepted the email and before `SENT` is written can produce a duplicate after the 10-minute reset. This is accepted and documented in the README.

Mailer failures for cancellation and rescheduled emails are recorded on the notification row exactly as for reminders (back to `PENDING` while `attempts < 5`, then `FAILED`).

The web process never talks to pg-boss. It only writes `Reminder` and `AppointmentNotification` rows inside the transaction that changes the appointment, so a committed booking, cancellation or reschedule always has its emails recorded, and a rolled-back one has none.

## 8. Edge cases

1. Adjacent appointments (`A.endsAt == B.startsAt`) for the same provider are both accepted.
2. Two concurrent bookings for the same slot: exactly one `201`, the other `409 slot_taken`.
3. A patient concurrently booking two overlapping slots with different providers: one succeeds, the other `409 patient_conflict`.
4. Spring forward (e.g. `America/New_York`, second Sunday of March): a window 01:00–04:00 with 30-minute slots offers 01:00, 01:30, 03:00, 03:30; the 02:00 and 02:30 candidates do not exist.
5. Fall back (first Sunday of November): a window 00:30–03:00 with 30-minute slots offers each wall time once; 01:00 and 01:30 map to the first occurrence; no two offered slots overlap in elapsed time.
6. Day view for a clinic-local date on a DST day covers 23 or 25 hours and includes an appointment at 23:30 local, excludes one at 00:00 the next day.
7. A patient in `Asia/Tokyo` booking a `America/Los_Angeles` clinic: the daily limit and horizon use the clinic's date, not the patient's and not UTC's.
8. "Today" for lead time and horizon near midnight: at 23:30 clinic time, a slot at 00:15 the next clinic day is `too_soon` with a 60-minute lead and bookable with a 30-minute lead.
9. Patient cancel at exactly `startsAt - 24 h` succeeds; one second later fails.
10. Cancelling an already cancelled appointment returns `409 invalid_state` and sends no second email.
11. Cancel and book racing on the same slot: the booking succeeds only if the cancellation committed first; no state where two `BOOKED` rows overlap.
12. Reschedule to a taken slot leaves the original appointment `BOOKED` with its reminders still `PENDING`.
13. Reschedule to a slot that overlaps the patient's own old appointment (e.g. 30 minutes later with a 60-minute slot) succeeds.
14. Booking 3 hours before start creates only `T2H`. Booking 90 minutes before start creates no reminders (both scheduled times are already past), as does a staff booking 30 minutes before start.
15. Reminder picked up after the appointment was cancelled is `SKIPPED`, not sent.
16. Worker down for three hours: on restart, a `T24H` reminder that is 3 hours stale is `SKIPPED`; a `T2H` that is 10 minutes stale is sent.
17. Idempotent replay with the same key and same slot returns the original; same key with a different slot is `422`.
18. `startsAt` supplied with an offset other than `Z` is accepted and normalised; a `startsAt` that is 1 ms off a slot boundary is `422 not_a_slot`.
19. A rule with `validTo` on date D still generates slots on D and none on D + 1.
20. A `CUSTOM_HOURS` exception on a weekday with no rule produces slots; `CLOSED` on a day with rules produces none.
21. Booking with an inactive provider or a provider in another clinic (staff) is refused.
22. A patient requesting another patient's appointment id gets `404`, identical to a non-existent id.
23. Slot range query crossing a DST change returns each day computed with that day's offset.
24. Invalid IANA zone at registration or clinic creation is rejected with `validation_failed`.
25. A cancellation that commits while the worker and queue are down still produces its email once the worker is back; a cancellation that rolls back produces none.
26. A reschedule produces exactly one email (rescheduled, for the new appointment) and no cancellation email for the old one.

## 9. Non-goals

Payments, insurance, video visits, recurring appointments, waitlists, multi-provider appointments, SMS, calendar sync, password reset, i18n, rate limiting.

## 10. Acceptance criteria

- A patient can register, find a slot, book, see it in their zone, reschedule and cancel within the rules above.
- Staff can maintain availability and see a correct day view for any date including DST days.
- No sequence of concurrent requests can produce overlapping `BOOKED` appointments for a provider or for a patient.
- Reminders are created, sent, skipped or failed exactly as in 5.6 and section 7.
- All edge cases in section 8 hold.

## 11. Required tests

Unit (pure, fixed clock):
- `resolveLocal` for normal, gap and overlap times in at least two zones (one southern-hemisphere).
- Slot generation: plain day, remainder dropped, exceptions, rule validity bounds, spring-forward day, fall-back day, lead time and horizon at day boundaries.
- Local-day range length on DST days.
- Cancellation policy at the 24 h boundary for each role.
- Reminder planning for bookings 30 minutes, 90 minutes, 3 hours and 3 days ahead.
- Reminder email formatting when patient and clinic zones differ.

Integration (Postgres):
- Concurrent booking of one slot (`Promise.all` of N requests) yields one success.
- Adjacent bookings both succeed; overlapping patient bookings conflict.
- Idempotency key replay and mismatch.
- Cancel then rebook the freed slot; double cancel.
- Reschedule success, reschedule failure leaves original intact, reschedule into own overlapping window.
- Permission matrix: each role against appointment read, cancel, availability management; `404` for foreign appointment ids.
- Day view query boundaries.
- Dispatch + send handlers: sent, skipped on cancelled, skipped when stale, retry then `FAILED` after five attempts, stuck `SENDING` reset.
- Appointment notifications: row written with cancel and with reschedule (one row, new appointment), none on rollback or failed reschedule; dispatch and send for both kinds; retry then `FAILED`.

## 12. Commit plan

1. `chore`: scaffold (Next config, tsconfig, ESLint/Prettier, env module, logger, compose, `.env.example`).
2. `feat`: Prisma schema and initial migration including exclusion constraints; DB client.
3. `feat`: auth (register, login, sessions, role guards) and error envelope plumbing.
4. `feat`: time utilities and slot generation with unit tests.
5. `feat`: availability rules and exceptions (service, API, validation, tests).
6. `feat`: booking, cancellation, reschedule, completion services and API with integration tests.
7. `feat`: reminders: planning, worker, dispatch/send handlers, mailer interface, tests.
8. `feat`: patient UI (booking flow, my appointments).
9. `feat`: staff and admin UI (day view, availability editor, admin screens).
10. `test`: permission matrix and concurrency integration suites.
11. `docs`/`ci`: seed script, README, CI workflow.
