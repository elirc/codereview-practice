# codereviewbuild

Thirteen production-shaped apps for code-reading practice. Each folder has a `SPEC.md`
(read it first, then review the code against it), a `DECISIONS.md`, a `README.md`,
and its own CI workflow in `.github/workflows/`. Shared rules are in `CONVENTIONS.md`.

| # | Folder | Stack | Where the bugs live |
|---|--------|-------|---------------------|
| 1 | `01-clinic-booking` | Next.js + Prisma + Postgres + pg-boss worker | time zones, overlapping slots, double-booking |
| 2 | `02-expense-tracker` | FastAPI + SQLAlchemy + Alembic + React | money, conversion, approval state machine, permissions |
| 3 | `03-issue-tracker` | Fastify + Kysely + Postgres + React | tenant scoping, IDOR, cursor pagination, optimistic UI |
| 4 | `04-shop-inventory` | Django + DRF + Postgres + Celery | stock reservation, idempotent webhooks, partial refunds |
| 5 | `05-event-ticketing` | Rails 8 + Solid Queue + Hotwire | capacity check-then-act, expiring holds, promo stacking |
| 6 | `06-cms-publishing` | Next.js + Drizzle + Postgres + S3/MinIO | server-action authz, upload validation, cache invalidation |
| 7 | `07-rental-manager` | Go (chi + sqlc + pgx) + htmx | ledger correctness, proration, month-end dates |
| 8 | `08-volunteer-scheduler` | SvelteKit + SQLite (Drizzle) | recurrence, sign-up limits, exactly-once notifications, CSV |
| 9 | `09-payments-ledger` | Kotlin + Spring Boot 3 + Postgres (Flyway) + outbox → Kafka | double-entry invariants under concurrency, holds, idempotent retries, FX rounding, reconciliation |
| 10 | `10-collab-docs` | Fastify + `ws` + Yjs + Postgres + Redis pub/sub + React | per-message WebSocket authz, multi-instance fan-out, log compaction, comment anchors |
| 11 | `11-delivery-dispatch` | 3 Go services (chi + pgx + sqlc) + PostGIS + NATS JetStream | at-least-once consumers, out-of-order events, double assignment, offer timers, saga compensation |
| 12 | `12-saas-billing` | .NET 10 minimal APIs + EF Core 10 + Postgres + worker | proration, period boundaries, late usage, invoice immutability, one invoice per period, signed webhooks |
| 13 | `13-workflow-engine` | Rust (axum + sqlx + tokio) + Postgres + worker binary | leases and fencing, SKIP LOCKED claiming, cron catch-up, DAG fan-in, graceful shutdown |

Projects 01–08 are wave 1. Projects 09–13 are wave 2: several processes or services each,
with messaging between them; see section 12 of `CONVENTIONS.md`.

Each project was built as a series of PR-sized commits. To read one project's history:

    git log --reverse --oneline build/01-clinic-booking ^df14309 -- 01-clinic-booking

Nothing has been installed or run yet: the first `npm install` / `pip install` /
`bundle install` / `go mod tidy` / `gradle build` / `dotnet restore` / `cargo build`
and CI run is the first real check.
