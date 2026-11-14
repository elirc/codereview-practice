# Workflow Engine

A durable background-job and workflow engine backed by Postgres. Clients enqueue jobs on named
queues with priorities, delays and unique keys; cron schedules create jobs on time and catch up
after downtime; workflows run a graph of steps, handing each step's output to the steps that
depend on it. A worker binary runs the jobs, and a server binary exposes the API, runs the
background loops and serves a one-page admin console.

## Setup

Requirements: Rust 1.84.0 (pinned in `rust-toolchain.toml`; `rustup` installs it on first use)
and Docker for Postgres 16.

```sh
cp .env.example .env          # adjust if needed; both binaries read the environment
docker compose up -d           # Postgres on localhost:5465
cargo build --workspace        # also writes Cargo.lock
cargo run -p wfe-server -- migrate
cargo run -p wfe-server -- seed
```

The binaries read their settings from the process environment. Export the variables from
`.env` (for example `set -a; . ./.env; set +a`) before running them.

## Run

| Process | Command | Notes |
|---|---|---|
| API server, scheduler, reaper, purge | `cargo run -p wfe-server -- serve` | Port 8130; `LOOPS_ENABLED=false` turns the loops off |
| Worker | `cargo run -p wfe-worker` | Claims from `WORKER_QUEUES`; run as many as you like |
| Migrations | `cargo run -p wfe-server -- migrate` | The only way the schema changes |
| Seed data | `cargo run -p wfe-server -- seed` | Safe to run again |

Open <http://localhost:8130/> for the admin console and paste one of the seed tokens. API calls
need `Authorization: Bearer <token>`:

```sh
curl -s -X POST localhost:8130/api/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"queue":"default","kind":"noop","payload":{"hello":"world"}}'
```

Both binaries may run as several instances. Stop a worker with Ctrl-C or `SIGTERM`; it stops
claiming, lets running jobs finish within `SHUTDOWN_GRACE_SECONDS`, and gives back what is
left.

## Test

```sh
docker compose up -d
export DATABASE_URL=postgres://wfe:wfe@localhost:5465/wfe
cargo test --workspace
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

Database tests use `#[sqlx::test]`, which creates a fresh database per test from `migrations/`;
the `DATABASE_URL` user needs permission to create databases. Unit tests in `engine-core` need
no database. Worker tests that depend on durations use an in-memory store and paused Tokio time.

## Architecture

```
crates/engine-core     pure logic: states, failure and expiry rules, back-off, token bucket,
                       cron planning, workflow validation and readiness, run resolution,
                       authorisation rules, Clock / SyncedClock / JitterSource
crates/engine-store    every SQL statement: queues, jobs, claim, leases, reaper, schedules,
                       workflows and their progression, tokens, purge, clock sync
crates/server          wfe-server: axum API (routes/), auth middleware, error envelope,
                       background loops, seed, static/admin.html
crates/worker          wfe-worker: claim loop, per-job runner with heartbeats, handlers,
                       shutdown
migrations/            SQL migrations embedded by sqlx::migrate!
```

Request flow: `request_id` middleware → trace span → bearer-token middleware (puts a `Caller` in
the request) → handler, which checks the caller's role and queue scope and calls
`engine-store`. Errors from any layer become the JSON envelope through `ApiError`.

Job flow: `POST /api/jobs` (or a schedule pass, or a workflow step becoming ready) inserts a
`pending` row → a worker's claim moves it to `running` and records an attempt → the worker
heartbeats while the handler runs → the outcome moves the job to `succeeded`, back to `pending`
for a retry, `dead` or `cancelled` → for workflow jobs, the same transaction updates the step
and the run. The reaper ends claims whose lease ran out.

Ownership:

| Process | Writes |
|---|---|
| `wfe-server` API | `queues`, `api_tokens`, `schedules`, `workflow_definitions`, new `jobs`, `workflow_runs` and `workflow_steps`; cancel and requeue |
| `wfe-server` scheduler | `schedules.next_fire_at` / `last_fire_at`, scheduled `jobs` |
| `wfe-server` reaper | expired `jobs`, their `job_attempts`, affected steps and runs |
| `wfe-server` purge | deletes finished `jobs` and `workflow_runs` |
| `wfe-worker` | claimed `jobs`, `job_attempts`, `queues` rate buckets, affected steps and runs |

There is no broker: the `jobs` table is the queue.

## Where the hard parts live

| Topic | Files |
|---|---|
| Claiming, ordering, concurrency cap, rate limit | `crates/engine-store/src/claim.rs`, `crates/engine-core/src/rate.rs` |
| Heartbeats, completion, failure, release | `crates/engine-store/src/lease.rs` |
| Lease expiry | `crates/engine-store/src/reaper.rs` |
| Retry back-off | `crates/engine-core/src/backoff.rs`, `crates/engine-core/src/outcome.rs` |
| Unique keys and requeue | `crates/engine-store/src/jobs.rs`, `migrations/0001_queues_jobs_tokens.sql` |
| Cancellation | `crates/engine-store/src/jobs.rs`, `crates/worker/src/runner.rs` |
| Worker heartbeats, abandonment and reporting | `crates/worker/src/runner.rs` |
| Worker shutdown | `crates/worker/src/worker.rs` |
| Clock synchronisation | `crates/engine-core/src/clock.rs`, `crates/engine-store/src/clock_sync.rs` |
| Cron catch-up | `crates/engine-core/src/cron_plan.rs`, `crates/engine-store/src/schedules.rs` |
| Workflow validation | `crates/engine-core/src/dag.rs` |
| Workflow progression, cancel, retry | `crates/engine-store/src/progress.rs`, `crates/engine-core/src/resolve.rs` |
| Retention | `crates/engine-store/src/purge.rs` |
| Authorisation | `crates/engine-core/src/authz.rs`, `crates/server/src/auth.rs` |
| Error envelope | `crates/server/src/error.rs`, `crates/server/src/extract.rs` |

## Seed accounts

`wfe-server seed` creates these tokens. They are for local development only.

| Role | Queues | Token |
|---|---|---|
| admin | all | `wfe_dev_admin_5f2b9c7e1a4d8e3f6b0c2a9d7e5f1b3c8a6d4e2f0b9c7a5e3d1f8b6c4a2e0d9f7b` |
| operator | all | `wfe_dev_operator_9a1c3e5f7b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a` |
| viewer | all | `wfe_dev_viewer_2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a5c7e9b1d3f5a` |
| submitter | `email`, `default` | `wfe_dev_submitter_7e9b1d3f5a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0b1d3f5a7c9e2b4d6f8a0c1e3b` |

The seed also creates the queues `default`, `email` (60 per minute, burst 10) and `reports`
(at most 2 running), the `nightly-report` schedule, the `etl` workflow with one run, and a few
jobs, one of which ends up as a dead letter once a worker runs it.
