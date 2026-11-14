# Clinic Booking

A booking system for a small group of clinics. Staff define when providers work, patients book, reschedule and cancel appointments online, and a background worker emails reminders. Built with Next.js 15 (App Router), Prisma on PostgreSQL 16 and pg-boss.

## Setup

Requirements: Node 22, Docker (for Postgres).

```sh
cp .env.example .env
docker compose up -d            # Postgres 16 on localhost:5451, plus a clinic_booking_test database
npm install                     # generates package-lock.json on first run
npx prisma migrate deploy       # applies prisma/migrations
npm run db:seed                 # idempotent demo data, see "Seed accounts"
```

Dependencies are pinned to exact versions in `package.json`; the lockfile is created by the first `npm install` and should be committed from there.

The initial migration adds constraints Prisma cannot model (the `btree_gist` exclusion constraints, check constraints and the partial unique index `appointments_patient_idempotency_key`). `prisma migrate deploy` is the supported way to apply migrations, locally and in CI. `prisma migrate dev` reports drift for these objects and may propose dropping the partial index, so write new migrations with `prisma migrate dev --create-only`, review the generated SQL, and remove any statement that drops or alters them.

## Run

```sh
npm run dev       # web app and JSON API on http://localhost:3000
npm run worker    # pg-boss worker: reminder dispatch cron, reminder and email jobs
```

The worker creates its queues on start and schedules `reminders.dispatch` every minute; there is no separate scheduler process. With `MAILER=console` every email is written to the worker's log instead of being delivered.

Production: `npm run build && npm run start` for the web process and `npm run worker` alongside it. `next build` evaluates route modules, so the environment variables must be present at build time too.

## Test

```sh
npm run test:unit            # pure domain logic, fixed clocks, no database
npm run test:integration     # route handlers against a real Postgres
npm test                     # both
```

Integration tests read `TEST_DATABASE_URL` (falling back to `DATABASE_URL`), truncate every table before each test and run files one at a time. Apply migrations to the test database first:

```sh
DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy
```

`npm run lint`, `npm run typecheck` and `npm run format:check` match the CI workflow in `.github/workflows/01-clinic-booking.yml`.

## Architecture

```
prisma/
  schema.prisma          models, mapped to snake_case tables
  migrations/            SQL, including exclusion and check constraints
  seed.ts                idempotent demo data
src/
  domain/                pure logic, no I/O: time, slots, availability, policies, reminders, emails
  services/              transactions and authorisation: booking, appointments, availability, admin
  server/                env, logger, Prisma client, error envelope, route wrapper, auth, jobs, mailer
  app/                   pages (server components) and api/**/route.ts JSON handlers
  worker/                pg-boss worker entry point and job handlers
tests/
  unit/                  domain tests
  integration/           HTTP-level tests through the route handlers
```

Request flow: a route handler is wrapped by `route()` in `src/server/http.ts`, which assigns a request id, enforces the CSRF rule (JSON content type and matching `Origin`) on mutating methods, and turns any thrown `AppError` into the error envelope. The handler resolves the session, validates input with zod, reads the clock once and calls a service. Services run their writes in Prisma transactions and call pure functions in `src/domain` for every rule about time, slots and policies.

Pages are server components that call the same services directly. Every mutation from the UI goes through the JSON API with `fetch`, so business errors always use the one envelope.

Job flow: the web process writes `Reminder` rows inside the booking transaction and, after commit, enqueues `email.cancellation` or `email.rescheduled` through pg-boss. The worker's `reminders.dispatch` cron claims due reminders and enqueues one `reminders.send` per row; `reminders.send` re-checks the appointment and delivers through the `Mailer` interface.

Reminder delivery is at-least-once. If the worker crashes after the mail provider accepted a message but before the row is marked `SENT`, the claim expires after ten minutes and the reminder can be sent again. This is accepted; duplicates are preferred over silently lost reminders.

## Where the hard parts live

| Topic | Files |
|---|---|
| Wall time to instant, DST gaps and overlaps | `src/domain/time.ts` |
| Slot generation, lead time and horizon | `src/domain/slots.ts`, `src/services/slots.ts` |
| Rule overlap and affected appointments | `src/domain/availability.ts`, `src/services/availability.ts`, `src/services/schedule.ts` |
| Booking transaction and idempotency keys | `src/services/booking.ts`, `src/app/api/appointments/route.ts` |
| Overlap constraints and their error mapping | `prisma/migrations/20261101090000_init/migration.sql`, `src/server/db-errors.ts` |
| Cancellation, reschedule and outcomes | `src/domain/policies.ts`, `src/services/appointments.ts` |
| Appointment visibility per role | `src/services/access.ts`, `src/services/appointments.ts` |
| Clinic-local day queries | `src/services/appointments.ts`, `src/app/staff/day/page.tsx` |
| Reminder planning, claiming and sending | `src/domain/reminders.ts`, `src/worker/reminders.ts`, `src/worker/index.ts` |
| Email time formatting across zones | `src/domain/emails.ts` |
| Sessions, CSRF and the error envelope | `src/server/auth/`, `src/server/http.ts`, `src/server/errors.ts` |

## Seed accounts

All seeded accounts use the password `clinic-demo-pass`.

| Role | Email | Notes |
|---|---|---|
| Admin | `admin@clinic.test` | All clinics |
| Staff | `staff.harbour@clinic.test` | Harbour Clinic, America/New_York |
| Staff | `staff.bayside@clinic.test` | Bayside Clinic, America/Los_Angeles |
| Provider | `dr.lee@clinic.test` | Harbour, weekdays 09:00–12:00 and 13:00–17:00, 30-minute slots |
| Provider | `dr.patel@clinic.test` | Harbour, Tuesday and Thursday 08:00–12:00, 60-minute slots |
| Provider | `dr.garcia@clinic.test` | Bayside, weekdays 08:00–12:00, 20-minute slots |
| Patient | `ana@patient.test` | America/New_York, one upcoming and one completed visit |
| Patient | `kenji@patient.test` | Asia/Tokyo, booked at the Los Angeles clinic |
