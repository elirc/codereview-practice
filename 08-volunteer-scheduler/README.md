# Volunteer Scheduler

A shift scheduler for a single nonprofit. Coordinators publish one-off and recurring shifts, volunteers sign up within capacity limits (with a waitlist), and a background worker sends email and SMS confirmations, reminders and change notices through an outbox. Volunteers can be imported from CSV and rosters exported.

## Setup

Requirements: Node 22. Everything else is an npm dependency; the database is a single SQLite file.

```sh
cd 08-volunteer-scheduler
npm install            # creates package-lock.json; also runs `svelte-kit sync`
cp .env.example .env   # optional: every variable has a development default
npm run db:migrate     # applies drizzle/*.sql to DATABASE_PATH (creates the folder)
npm run db:seed        # idempotent demo data, see "Seed accounts"
```

Configuration is read once at start-up by `src/lib/server/config.ts` from the environment (a local `.env` file is loaded when present) and the process exits if a value is invalid. `ORG_TIMEZONE` (default `America/New_York`) is the zone for every shift time, reminder, quiet-hours check and export.

After changing `src/lib/server/db/schema.ts`, generate the next migration with `npm run db:generate`.

## Run

Two processes share the same database file:

```sh
npm run dev       # web app on http://localhost:5173
npm run worker    # outbox dispatcher (every 5 s) and scheduled jobs (every 30 s)
```

Production:

```sh
npm run build
PORT=3000 ORIGIN=https://volunteers.example.org node build
npm run worker
```

`ORIGIN` must match the public URL because SvelteKit's origin check is the CSRF protection for form actions. Set `BODY_SIZE_LIMIT` (see `.env.example`) so 2 MiB CSV uploads are accepted. The worker stops after finishing its current batch on `SIGTERM`/`SIGINT`. Notifications go to the console providers, which log each message instead of delivering it.

## Test

```sh
npm test                  # all suites
npm run test:unit         # pure domain logic
npm run test:integration  # services, form actions and endpoints on temp SQLite files
npm run lint              # prettier --check and eslint
npm run check             # svelte-check (types)
```

Integration tests create a migrated temp database per test, use a fixed clock, and call form actions and `+server.ts` handlers directly. The concurrency suite starts child processes (`node --import tsx tests/support/child.ts`) that open the same file and race each other.

## Architecture

```
drizzle/                     SQL migrations and journal (drizzle-kit format)
scripts/                     migrate.ts, seed.ts
src/
  hooks.server.ts            request id, logging, session → event.locals.user, error shape
  lib/
    domain/                  pure code shared with the browser
      dates.ts               civil-date arithmetic
      time.ts                wall time ↔ instant in the organisation zone
      recurrence.ts          occurrences(rule, from, to)
      phone.ts               E.164 normalisation
    components/              FormError, SeriesForm (live occurrence preview)
    server/
      config.ts, logger.ts, app.ts, context.ts
      db/                    schema, connection (pragmas), migrator
      auth/                  scrypt passwords, sessions, invites, requireRole
      services/              shifts, series, waitlist, signups, users, import, exports
      outbox/                enqueue, templates/render, providers, dispatcher, admin
      jobs/                  runner, materialize, reminders, cleanup
      csv/                   parse.ts, write.ts, values.ts
      forms.ts, http.ts      form-action failures and the JSON error envelope
      schemas.ts             zod schemas for forms and query strings
  routes/                    pages with form actions; +server.ts for CSV and health
  worker/main.ts             worker process
tests/
  unit/                      recurrence, time, CSV, phone, backoff/quiet hours, config
  integration/               one file per area, plus concurrency and failure modes
  support/                   temp-db context, fake events, factories, recording providers
```

**Request flow.** `hooks.server.ts` assigns a request id, resolves the `vs_session` cookie to a user and attaches the shared `AppContext` (database, zone, clock, logger). Each `load`, form action and endpoint calls `requireUser`/`requireRole` itself, validates input with zod (`parseForm`), and calls a service. Services run multi-statement writes in `BEGIN IMMEDIATE` transactions and throw `DomainError`s, which `forms.ts` turns into `fail(status, { error, values })` and `http.ts` into `{ "error": { code, message, details, requestId } }`.

**Notifications.** Services insert outbox rows in the same transaction as the change (`outbox/enqueue.ts`). The worker's dispatcher claims due rows, re-checks them against current data, renders the message, applies SMS quiet hours, calls the provider with the dedupe key as idempotency key, and records the outcome with retries and backoff.

**Jobs.** The worker checks the `jobs` table every 30 s; a due job is locked with a conditional update, run, and rescheduled. `materialize` keeps 60 days of series shifts stored, `reminders` queues 24-hour reminders, and `cleanup` removes expired sessions, invites and old delivered notifications.

## Where the hard parts live

| Topic | Files |
|---|---|
| Recurrence rules and the candidate cap | `src/lib/domain/recurrence.ts` |
| Wall time to instant across DST | `src/lib/domain/time.ts` |
| Materialisation, series edits, exceptions | `src/lib/server/services/series.ts` |
| Shift edits and cancellation | `src/lib/server/services/shifts.ts` |
| Capacity, waitlist, overlap, cut-offs, promotion | `src/lib/server/services/signups.ts`, `src/lib/server/services/waitlist.ts` |
| Outbox dedupe and channel selection | `src/lib/server/outbox/enqueue.ts` |
| Dispatcher claim, validation, quiet hours, retries | `src/lib/server/outbox/dispatcher.ts`, `src/lib/server/outbox/render.ts`, `src/lib/server/outbox/schedule.ts` |
| Job locking and backoff | `src/lib/server/jobs/runner.ts` |
| Reminder window | `src/lib/server/jobs/reminders.ts` |
| CSV parsing and writing | `src/lib/server/csv/parse.ts`, `src/lib/server/csv/write.ts` |
| Volunteer import | `src/lib/server/services/import.ts` |
| Exports and date ranges | `src/lib/server/services/exports.ts` |
| Sessions, invites, role checks | `src/lib/server/auth/session.ts`, `src/lib/server/auth/invite.ts`, `src/lib/server/auth/guard.ts` |
| Database constraints | `drizzle/0000_initial_schema.sql`, `src/lib/server/db/schema.ts` |
| Concurrency and failure tests | `tests/integration/concurrency.test.ts`, `tests/integration/failure-modes.test.ts` |

## Seed accounts

`npm run db:seed` creates these users (and a weekly pantry series, a monthly clean-up series, a one-off shift and a few signups). Running it again changes nothing that already exists.

| Role | Email | Password |
|---|---|---|
| admin | admin@example.org | admin-password |
| coordinator | coordinator@example.org | coordinator-password |
| volunteer | volunteer@example.org | volunteer-password |
| volunteer (SMS on) | sam@example.org | volunteer-password |
