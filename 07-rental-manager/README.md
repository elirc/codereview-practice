# Rental Manager

A back-office tool for a small landlord: properties, units, tenants and leases, with an append-only rent ledger per lease. Rent charges (with proration), payments, credits, late fees and reversals are all ledger entries; balances, statements, the rent roll and aged receivables are derived from them. Tenants do not log in.

## Setup

Requirements: Go 1.23, Docker (for Postgres 16), and optionally sqlc 1.27.0 to regenerate the store.

```sh
cp .env.example .env               # the Makefile exports it; set -a; . ./.env; set +a for a shell
go mod tidy                        # writes go.sum (not committed)
make htmx                          # fetches htmx 2.0.4 into internal/web/static/vendor/
make db-up                         # Postgres on localhost:5457 with rentmgr and rentmgr_test databases
make migrate                       # rentmgr migrate up
make seed                          # demo data and the accounts below
```

The files in `internal/store/db/` were written by hand to match sqlc 1.27.0 output. On first setup run `sqlc generate` (or `make sqlc`) and commit any diff.

`github.com/alexedwards/scs/pgxstore` has no tagged release and is pinned by pseudo-version; if `go mod tidy` cannot resolve it, run `go get github.com/alexedwards/scs/pgxstore@latest` once.

htmx is not committed. Without `make htmx` the pages still work as plain forms. The command it runs is:

```sh
curl -fsSL -o internal/web/static/vendor/htmx.min.js https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js
```

Configuration is read once at start-up from the environment (see `.env.example`): `DATABASE_URL`, `HTTP_ADDR`, `APP_ENV`, `APP_TIMEZONE` (IANA zone that defines "today", default `America/Chicago`), `LOG_LEVEL`.

## Run

```sh
go run ./cmd/rentmgr serve          # web UI on http://localhost:8087
go run ./cmd/rentmgr worker         # every 15 minutes: post-rent, then assess-late-fees, once per day
go run ./cmd/rentmgr run-job post-rent --as-of 2026-03-01
go run ./cmd/rentmgr run-job assess-late-fees
go run ./cmd/rentmgr migrate status
go run ./cmd/rentmgr rebuild-balances   # recompute lease_summaries from ledger_entries
```

The worker is the scheduler; run one or several, they coordinate through Postgres advisory locks. Admins can also run a job from **Jobs** in the UI.

## Test

```sh
make test        # go test -p 1 -count=1 ./... ; integration tests need TEST_DATABASE_URL
make test-unit   # unit tests only (integration tests skip without TEST_DATABASE_URL)
make lint        # gofmt, go vet, staticcheck 2024.1.1
make sqlc        # regenerate internal/store/db from the queries
```

Integration tests truncate and reuse the database named by `TEST_DATABASE_URL`, so packages must run one at a time (`-p 1`). Tests use a fixed clock; nothing depends on the wall clock or the machine's zone.

## Architecture

```
cmd/rentmgr/            serve, worker, migrate, seed, run-job, rebuild-balances
migrations/             goose SQL migrations (embedded)
internal/config/        environment configuration
internal/money/         Cents, decimal parsing and formatting, half-up rounding
internal/calendar/      civil dates, YYYY-MM periods, clock and business "today"
internal/billing/       pure rules: schedule and proration, allocation, late fees, aging
internal/ledger/        posting, reversal, statements and reports over the store
internal/lease/         lease lifecycle: draft, activate, edit, end
internal/jobs/          job runner, advisory lock, per-lease transactions
internal/auth/          users, bcrypt, roles and permissions
internal/apperr/        domain error kinds and validation errors
internal/store/         pool, WithTx, conversions; queries/ (sqlc input), db/ (sqlc output)
internal/web/           router, middleware, handlers, templates, static files
internal/testdb/        test database and fixtures for integration tests
```

Request flow: chi router → request id → JSON request log → panic recovery → body limit → session (scs, Postgres) → CSRF (nosurf) → current user → role check → handler. Handlers parse input into typed values, call a service in `lease`, `ledger` or `auth`, and either redirect, render a page, or render an htmx fragment. Every error goes through `classify` in `internal/web/errors.go`, which produces a page, a fragment or the JSON envelope.

Job flow: `worker` ticks every 15 minutes; for each job without an `ok` run today it calls `Runner.Run`, which takes the job's advisory lock on a dedicated connection, records a `job_runs` row, and processes each active or ended lease in its own transaction with the lease row locked. `run-job` and the admin button use the same path.

## Where the hard parts live

| Topic | Files |
|---|---|
| Civil dates, clamping, business "today" | `internal/calendar/calendar.go`, `internal/calendar/period.go` |
| Money parsing and rounding | `internal/money/money.go` |
| Rent schedule, proration, charge dates | `internal/billing/schedule.go` |
| Allocation of payments | `internal/billing/allocation.go` |
| Late-fee decision | `internal/billing/latefee.go` |
| Aging buckets | `internal/billing/aging.go`, `internal/ledger/reports.go` |
| Idempotent posting and lease locking | `internal/ledger/post.go` |
| Rent posting and late-fee assessment | `internal/ledger/billing.go` |
| Reversals and manual entries | `internal/ledger/service.go` |
| Running balance and statements | `internal/store/queries/ledger.sql`, `internal/ledger/service.go` |
| Lease activation, overlap and ending | `internal/lease/lifecycle.go`, `migrations/00003_leases.sql` |
| Ledger constraints and triggers | `migrations/00004_ledger_entries.sql` |
| Job runner and advisory lock | `internal/jobs/jobs.go` |
| Transactions | `internal/store/store.go` |
| Error mapping | `internal/web/errors.go` |
| Sessions, CSRF, roles | `internal/web/middleware.go`, `internal/web/server.go`, `internal/auth/` |
| Form parsing | `internal/web/forms.go` |

## Seed accounts

Created by `rentmgr seed` (it does nothing if the admin account already exists):

| Role | Email | Password |
|---|---|---|
| admin | admin@example.com | admin-password-1 |
| manager | manager@example.com | manager-password-1 |
| viewer | viewer@example.com | viewer-password-1 |

The seed data, dated relative to today, has two properties with five units: a lease paid on time except for the current month, a mid-month start with a partial late payment, a draft lease, a lease that ended last month with its final month unpaid followed by a new lease on the same unit, and a lease carrying a credit balance.
