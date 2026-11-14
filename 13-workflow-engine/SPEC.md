# 13 — Workflow Engine

## 1. Purpose

A durable background-job and workflow engine backed by Postgres. Clients enqueue jobs on named queues with priorities, delays and unique keys; cron schedules create jobs on time and catch up after downtime; workflows run a DAG of steps, passing each step's output to the steps that depend on it. A separate worker binary claims jobs under leases, heartbeats while it works, retries with back-off, and shuts down gracefully. A server binary exposes the API, runs the scheduler and lease reaper, and serves a one-page admin console. Read `../CONVENTIONS.md` first, including section 12.

Conventions pointer: doc comments and comments say what a function does and returns. They never name the race, duplicate run, stale worker or lost lease a piece of code is there for, and never describe the locking, fencing, claiming or fan-in design (CONVENTIONS §4 and §12.1).

## 2. Stack and fixed decisions

| Concern | Choice |
|---|---|
| Language | Rust, edition 2021, toolchain pinned to 1.84.0 in `rust-toolchain.toml` (components `rustfmt`, `clippy`). Cargo workspace; every dependency pinned with `=` in `[workspace.dependencies]` |
| HTTP | `axum` =0.7.9, `tower-http` =0.6.2 (`trace`), `tokio` =1.42.0 (`rt-multi-thread`, `macros`, `signal`, `time`, `sync`) |
| DB | PostgreSQL 16 (compose host port 5465). `sqlx` =0.8.2 with `default-features = false` and features `runtime-tokio`, `tls-rustls`, `postgres`, `uuid`, `chrono`, `json`, `migrate`, `macros`. Only the runtime API is used: `sqlx::query`, `query_as`, `query_scalar` with `.bind`, and `#[derive(sqlx::FromRow)]`. The compile-time macros `query!`/`query_as!` are not used |
| Migrations | SQL files in `migrations/` (`NNNN_name.sql`), embedded with `sqlx::migrate!("../../migrations")` and applied by `wfe-server migrate` only |
| Types | `uuid` =1.11.0 (`v4`, `serde`), `chrono` =0.4.38 (`serde`), `serde` =1.0.215 (`derive`), `serde_json` =1.0.133 |
| Errors | `thiserror` =1.0.69 for typed errors in library crates; `anyhow` =1.0.93 only in `main` functions and handler internals |
| Other | `cron` =0.12.1 (six- or seven-field expressions: sec min hour day-of-month month day-of-week [year]; UTC), `rand` =0.8.5, `sha2` =0.10.8, `hex` =0.4.3, `async-trait` =0.1.83, `tokio-util` =0.7.12 (`CancellationToken`), `reqwest` =0.12.9 (`default-features = false`, `rustls-tls`, `json`) |
| Logging | `tracing` =0.1.41, `tracing-subscriber` =0.3.19 (`json`, `env-filter`); request id middleware; spans carry `job_id`, `attempt`, `worker_id` |
| Tests | `#[tokio::test]` for pure async code; `#[sqlx::test(migrations = "../../migrations")]` for database tests (needs `DATABASE_URL`; CI provides a Postgres service container). HTTP tests call the router with `tower` =0.5.2 `ServiceExt::oneshot` and `http-body-util` =0.1.2. Time is a `FixedClock`; jitter is a fixed `JitterSource` |
| Lint | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` |
| Auth | API tokens (CONVENTIONS §12.8) checked by an axum middleware that puts a `Caller` in request extensions. Workers connect to the database directly and use no token |

Style: owned types (`String`, `Vec`, `serde_json::Value`) in structs and function signatures; `Arc` for shared state; no lifetime parameters on public types, no `unsafe`, no macros of our own, no `unwrap`/`expect` outside tests and start-up configuration.

Workspace:

```
crates/engine-core     pure: states and transition rules, back-off, token bucket, cron planning, DAG validation and
                       readiness, run resolution, Clock and JitterSource traits
crates/engine-store    every SQL statement: queues, jobs (enqueue, claim, heartbeat, complete, fail, release, reap, cancel,
                       requeue), schedules, workflows, tokens, clock sync
crates/server          bin wfe-server: serve | migrate | seed; axum API, scheduler/reaper/purge loops, static admin page
crates/worker          bin wfe-worker: claim loop, heartbeats, handlers, shutdown
migrations/
```

API port 8130. Both binaries may run as several instances.

**Clock.** `engine-core` defines `trait Clock { fn now(&self) -> DateTime<Utc>; }`. Every SQL statement that reads or writes a time takes `now` as a bound parameter; no statement uses `now()` or `CURRENT_TIMESTAMP` except the clock-sync query. In production both binaries use `SyncedClock`: at start and every 30 s it runs `SELECT now()` , estimates the database's offset from the local clock (using the midpoint of the round trip) and thereafter returns local time plus that offset. A measured offset beyond `CLOCK_SKEW_WARN_MS` (5000) is logged. Durations measured inside one process (heartbeat intervals, shutdown grace, time since the last successful heartbeat) use `tokio::time::Instant`, not `Clock`.

## 3. Roles and permissions

A token has a role and, for `submitter`, a list of queue names (`*` for all).

| Action | viewer | submitter | operator | admin |
|---|---|---|---|---|
| Read queues, jobs, schedules, definitions, runs | all | jobs and runs only in its queues; queues it may use | all | all |
| Enqueue jobs | no | its queues | yes | yes |
| Start workflow runs | no | only if every step's queue is in its list | yes | yes |
| Cancel a job or a run | no | in its queues | yes | yes |
| Requeue dead jobs, retry failed runs | no | no | yes | yes |
| Pause/resume queues and schedules | no | no | yes | yes |
| Create and edit queues, schedules, workflow definitions | no | no | no | yes |
| Manage tokens | no | no | no | yes |

A submitter asking for a job or run outside its queues gets `404 not_found`. Other role failures are `403 forbidden`. The admin page is static and holds no data; it calls the API with a token the user pastes.

## 4. Domain model

- **Queue**: `name` (primary key, `[a-z0-9_-]{1,64}`), `paused`, `max_concurrency?` (>= 1), `rate_limit_per_minute?` (>= 1), `rate_burst?` (>= 1, required with a rate limit), `rate_tokens_milli` (bigint), `rate_refilled_at`, `default_max_attempts` (1–50, default 5), `default_lease_seconds` (5–3600, default 60), `backoff_base_ms` (default 1000), `backoff_cap_ms` (default 3,600,000), `created_at`.
- **Job**: `id`, `queue`, `kind` (`[a-z0-9_.]{1,64}`), `payload` (jsonb, at most 65,536 bytes), `priority` (0–9, higher first, default 5), `state` (`pending` | `running` | `succeeded` | `dead` | `cancelled`), `run_at`, `attempt` (number of times claimed), `max_attempts`, `lease_seconds`, `lease_epoch` (bigint, default 0), `lease_owner?`, `lease_expires_at?`, `heartbeat_at?`, `cancel_requested`, `unique_key?` (1–200 chars), `result?` (jsonb, at most 262,144 bytes), `last_error?` (truncated to 2,000 chars), `dead_reason?` (`attempts_exhausted` | `permanent_failure` | `lease_expired`), `schedule_id?`, `scheduled_for?`, `workflow_run_id?`, `step_key?`, `created_by_token_id?`, `created_at`, `started_at?`, `finished_at?`.
- **JobAttempt**: `job_id`, `attempt`, `lease_epoch`, `worker_id`, `started_at`, `finished_at?`, `outcome?` (`succeeded` | `retryable_error` | `permanent_error` | `lease_expired` | `released` | `cancelled`), `error?`; primary key `(job_id, lease_epoch)`.
- **Schedule**: `id`, `name` (unique), `cron_expr`, `queue`, `kind`, `payload`, `priority`, `catchup` (`skip` | `latest` | `all`), `max_catchup` (1–100, default 10), `paused`, `next_fire_at`, `last_fire_at?`, `created_at`.
- **WorkflowDefinition**: `id`, `name`, `version` (assigned, starting at 1), `steps` (jsonb), `created_at`; unique `(name, version)`; immutable. A step is `{ key ([a-z0-9_]{1,40}), kind, queue, depends_on: [key], params (json), max_attempts?, lease_seconds?, priority? }`.
- **WorkflowRun**: `id`, `definition_id`, `state` (`running` | `succeeded` | `failed` | `cancelled`), `input` (jsonb), `cancel_requested`, `created_by_token_id?`, `created_at`, `finished_at?`.
- **WorkflowStep**: `run_id`, `step_key`, `state` (`blocked` | `queued` | `succeeded` | `failed` | `skipped` | `cancelled`), `job_id?`, `output?` (jsonb); primary key `(run_id, step_key)`. `queued` means the step has a job that is `pending` or `running`.
- **ApiToken**: `id`, `name`, `token_hash` (unique), `role`, `queues` (text array), `revoked_at?`.

Indexes and checks: `jobs (queue, priority DESC, run_at, id) WHERE state = 'pending'`; `jobs (lease_expires_at) WHERE state = 'running'`; unique `jobs (queue, unique_key) WHERE unique_key IS NOT NULL AND state IN ('pending', 'running')`; unique `jobs (workflow_run_id, step_key) WHERE workflow_run_id IS NOT NULL`; checks on state/lease consistency (`state = 'running'` ⇔ `lease_owner` and `lease_expires_at` are set), `attempt >= 0`, `priority BETWEEN 0 AND 9`.

## 5. Domain rules

### 5.1 Enqueue

`POST /api/jobs` `{ queue, kind, payload, priority?, run_at? | delay_seconds?, max_attempts?, lease_seconds?, unique_key? }`. The queue must exist (`422 unknown_queue`). `run_at` earlier than now becomes now; later than one year ahead is `400`. `max_attempts` and `lease_seconds` default from the queue at enqueue time and are then fixed on the job.

With a `unique_key`, the insert uses `ON CONFLICT (queue, unique_key) WHERE unique_key IS NOT NULL AND state IN ('pending', 'running') DO NOTHING`. If nothing was inserted, the live job holding the key is returned with `200` and `deduplicated: true` (its payload is not updated); if that job has meanwhile finished, the insert is tried once more. A new job is `201`. Once a job is `succeeded`, `dead` or `cancelled` its key is free again.

A paused queue still accepts jobs.

### 5.2 Claim

`claim(queue, kinds, worker_id, limit, now)` is one transaction per queue:

1. Read the queue; `paused` → nothing. If the queue has `max_concurrency` or a rate limit, lock its row `FOR UPDATE`; otherwise take no queue lock.
2. `allowance = limit`. With `max_concurrency`: `allowance = min(allowance, max_concurrency − running jobs in the queue)`. With a rate limit: refill `tokens = min(rate_burst × 1000, rate_tokens_milli + elapsed_ms × rate_limit_per_minute / 60)` where `elapsed_ms = max(0, now − rate_refilled_at)`; `allowance = min(allowance, tokens / 1000)`. `allowance <= 0` → nothing (the refill is still stored).
3. Select up to `allowance` jobs: `state = 'pending' AND run_at <= now AND kind = ANY(kinds) AND NOT cancel_requested`, ordered by `priority DESC, run_at, id`, `FOR UPDATE SKIP LOCKED`; update them to `running` with `attempt + 1`, `lease_epoch + 1`, `lease_owner = worker_id`, `lease_expires_at = now + lease_seconds`, `heartbeat_at = now`, `started_at = now`; insert a `JobAttempt` per job.
4. With a rate limit: subtract `1000 × claimed` tokens and set `rate_refilled_at = max(rate_refilled_at, now)`.

A token is consumed when a job starts, including retries. Jobs of a kind no worker lists stay `pending`.

### 5.3 Leases, heartbeats and fencing

- A lease is valid while `now < lease_expires_at`. The pair `(job id, lease_epoch)` identifies one claim. **Every write a worker makes about a job** — heartbeat, complete, fail, release, report cancelled — is a single statement conditioned on `id = $1 AND lease_epoch = $2 AND state = 'running'`. Zero rows affected is `LeaseLost`: the worker stops the handler if it is still running, discards the result, and writes nothing else for that claim.
- Heartbeat sets `lease_expires_at = now + lease_seconds`, `heartbeat_at = now` and returns `cancel_requested`. A heartbeat or completion that arrives after `lease_expires_at` but while the job is still `running` under the same epoch is accepted.
- **Reaper** (server): jobs with `state = 'running' AND lease_expires_at <= now`, `FOR UPDATE SKIP LOCKED`, batch 100. Each closes its attempt as `lease_expired` and then: `cancel_requested` → `cancelled`; `attempt >= max_attempts` → `dead` with `lease_expired`; otherwise → `pending` with `run_at = now + backoff(attempt)` and the lease columns cleared.
- An expired lease consumes an attempt. A released claim (5.7) does not.

### 5.4 Outcomes and retries

Handlers return `Ok(value)`, `Err(Retryable(msg))`, `Err(Permanent(msg))` or `Err(Cancelled)`. A handler panic is `Retryable("handler panicked")`.

- `Ok` → `succeeded`, `result` stored, even when `cancel_requested` is set. A result over the size limit is treated as `Permanent("result_too_large")`.
- `Retryable`: `cancel_requested` → `cancelled`; `attempt >= max_attempts` → `dead` (`attempts_exhausted`); otherwise `pending`, `run_at = now + backoff(attempt)`.
- `Permanent` → `dead` (`permanent_failure`), whatever attempts remain.
- `Cancelled` → `cancelled` if `cancel_requested`, else handled as `Retryable("cancelled without request")`.
- `backoff(n)`: `raw = backoff_base_ms × 2^min(n − 1, 30)`; `jittered = raw × (0.8 + 0.4 × r)` with `r` in `[0, 1)` from the `JitterSource`; `delay = min(backoff_cap_ms, jittered)`; arithmetic saturates.

Execution is at-least-once. Handlers receive `idempotency_key = <job id>` (stable across attempts) and must use it for external effects.

### 5.5 Cancellation and dead letters

- `POST /api/jobs/{id}/cancel`: `pending` → `cancelled` (conditional on state), `200`. `running` → `cancel_requested = true`, `202`; the worker sees it at its next heartbeat, cancels the handler's token and reports per 5.4. Terminal → `409 invalid_state`. A job that belongs to a workflow run → `409 workflow_job` (cancel the run).
- `POST /api/jobs/{id}/requeue`: `dead` only → `pending`, `attempt = 0`, `run_at = now`, `cancel_requested = false`, `last_error`/`dead_reason` cleared; attempts history is kept. If another live job holds the same `unique_key` → `409 unique_key_conflict`. Workflow jobs → `409 workflow_job` (retry the run).

### 5.6 Cron schedules

Expressions are validated with `cron::Schedule::from_str` on create and update (`422 invalid_cron`). On create and on resume, `next_fire_at` is the first fire time strictly after now.

The scheduler loop claims schedules with `NOT paused AND next_fire_at <= now` (`FOR UPDATE SKIP LOCKED`, batch 20), each in its own transaction:

1. Due fire times are `next_fire_at` and every later fire time `<= now`, but none earlier than `now − CATCHUP_HORIZON` (24 h). Call them `t1 … tn`. If none remain inside the horizon, enqueue nothing.
2. By `catchup`:
   - `skip`: one job for `tn`, only if `now − tn <= MISFIRE_GRACE_SECONDS` (60); otherwise none.
   - `latest`: one job for `tn`.
   - `all`: jobs for the latest `min(n, max_catchup)` fire times, oldest first.
3. Each job has `scheduled_for = t`, `schedule_id`, and `unique_key = "schedule:<id>:<t as RFC 3339 UTC seconds>"`, inserted with the deduplicating insert of 5.1.
4. `run_at`: when `now − tn <= MISFIRE_GRACE_SECONDS` and one job is created, `now`. Otherwise the `i`-th job (0-based) gets `now + stagger + i × CATCHUP_SPACING_SECONDS` (5), where `stagger` is the schedule id's first four bytes as an unsigned integer modulo `CATCHUP_STAGGER_SECONDS` (30).
5. `last_fire_at = tn` (when any fire was due) and `next_fire_at` = the first fire time strictly after `max(tn, now)`.

Fire times that passed while a schedule was paused are not caught up. Editing `cron_expr` recomputes `next_fire_at` from now. A schedule whose queue is paused still creates jobs.

### 5.7 Worker

Configuration: `WORKER_QUEUES`, `WORKER_CONCURRENCY` (default 8), `POLL_INTERVAL_MS` (500), `SHUTDOWN_GRACE_SECONDS` (30), `LEASE_SAFETY_MS` (2000). `worker_id` is `<hostname>-<8 random hex>`.

- **Loop**: while running, compute free slots, call `claim` on each configured queue in rotation for up to the free slots with the kinds of the registered handlers, spawn one task per job, sleep the poll interval when nothing was claimed.
- **Per job**: a heartbeat task ticks every `lease_seconds / 3`. `LeaseLost` → cancel the token and mark the claim abandoned. `cancel_requested` → cancel the token. A heartbeat that fails with a database error is retried on the next tick; when the time since the last successful heartbeat reaches `lease_seconds × 1000 − LEASE_SAFETY_MS` on the monotonic clock, the worker cancels the token and abandons the claim.
- **Reporting**: outcomes are written per 5.3/5.4. An abandoned claim is never reported. If the report fails with a database error it is retried with a short back-off until the abandonment deadline above, then dropped.
- **Handlers** (`#[async_trait] trait Handler { async fn run(&self, ctx: JobContext) -> Result<Value, HandlerError>; }`, registered by kind): `noop` (returns the payload); `sleep` (`{ ms }`, stops early with `Cancelled` when the token fires); `fail` (`{ mode, succeed_on_attempt? }`); `http` (`{ method, url, headers?, body?, timeout_ms? }`; sends `Idempotency-Key`; connect errors, timeouts, `5xx`, `408` and `429` are `Retryable`; other `4xx` are `Permanent`; returns `{ status, body }` with the body cut at 65,536 bytes); `merge` (returns `payload.parents`).
- **Shutdown** on `SIGTERM` or Ctrl-C: stop claiming at once; wait up to the grace period for running handlers and report those that finish; then cancel the remaining tokens and wait up to 5 s; then **release** every claim still held: `pending`, `run_at = now`, `attempt − 1`, lease cleared, attempt outcome `released` (conditioned as in 5.3); then exit.

### 5.8 Workflows

**Definitions.** 1–50 steps; keys unique; every `depends_on` key exists and is not the step itself; the graph is acyclic; every queue exists. Violations → `422 invalid_workflow` with `details.problems`. Creating a definition with an existing name adds the next version.

**Starting a run** (`POST /api/workflow-runs` `{ name, version?, input }`; latest version by default), one transaction: insert the run (`running`) and one step row per step; steps without dependencies are `queued` with a job, the rest `blocked`.

A step's job has `workflow_run_id`, `step_key`, the step's queue, kind and limits, no `unique_key`, and payload `{ "input": <run input>, "params": <step params>, "parents": { "<key>": <output>, … } }`.

**Lock order.** Any transaction that changes the state of a job belonging to a run locks the run row `FOR UPDATE` first, then the job. This covers completion, failure, reaping, cancellation and retry. Workers know the run id from the claimed job.

**When a step's job ends** (same transaction as the job's fenced state change):

- job `succeeded` → step `succeeded`, `output = result`. If the run is `running` and not `cancel_requested`: every `blocked` step whose `depends_on` are all `succeeded` becomes `queued` and gets a job.
- job `dead` → step `failed`. Every `blocked` step becomes `skipped`. Every other `queued` step: a `pending` job is `cancelled` and its step `cancelled`; a `running` job gets `cancel_requested`.
- job `cancelled` → step `cancelled`.
- Then **resolve the run**: if no step is `queued`: `cancelled` when `cancel_requested`; else `failed` when any step is `failed`; else `succeeded` when all steps are `succeeded`; `finished_at = now`.
- A job that goes back to `pending` for a retry changes nothing in the run.

**Cancel a run** (`running` only, else `409 invalid_state`): set `cancel_requested`; `blocked` steps → `cancelled`; `queued` steps as in the failure case; resolve the run. A step whose job still finishes successfully is recorded as `succeeded` with its output; nothing new is enqueued.

**Retry a run** (`failed` only): `failed` and `cancelled` steps get their job requeued as in 5.5 and become `queued`; `skipped` steps become `blocked`; `succeeded` steps and their outputs are kept; the run returns to `running` with `finished_at` cleared.

### 5.9 Queue controls and retention

- Pause stops claims; running jobs continue and may heartbeat, finish and retry (the retry waits `pending`). Resume re-enables claims.
- Changing `max_concurrency` or the rate limit applies to later claims; lowering concurrency does not interrupt running jobs. Setting a rate limit initialises `rate_tokens_milli` to the burst and `rate_refilled_at` to now.
- Purge: terminal jobs with `finished_at` older than `RETENTION_DAYS` (14) are deleted, except jobs of a run that is still `running`; runs (with steps and jobs) are deleted when the run finished longer ago than the retention. Batches of 1,000.

## 6. API surface

Prefix `/api`, `snake_case` JSON, cursor pagination (`?after=&limit=`, default 50, max 200).

| Method & path | Notes |
|---|---|
| `GET/POST /queues`, `GET/PATCH /queues/{name}` | |
| `POST /queues/{name}/pause`, `/resume`, `GET /queues/{name}/stats` | Stats: counts by state, oldest `pending` `run_at`, tokens available |
| `POST /jobs`, `GET /jobs/{id}`, `GET /jobs?queue=&state=&kind=` | Detail includes attempts |
| `POST /jobs/{id}/cancel`, `/requeue` | 5.5 |
| `GET/POST /schedules`, `GET/PATCH/DELETE /schedules/{id}`, `POST /schedules/{id}/pause`, `/resume` | 5.6; deleting a schedule leaves its jobs |
| `POST /workflow-definitions`, `GET /workflow-definitions/{name}` | all versions |
| `POST /workflow-runs`, `GET /workflow-runs/{id}`, `GET /workflow-runs?state=` | Detail lists steps with state, job id and output |
| `POST /workflow-runs/{id}/cancel`, `/retry` | 5.8 |
| `POST /tokens`, `DELETE /tokens/{id}` | Token value returned once |
| `GET /healthz` | no auth |
| `GET /` | static admin page (`crates/server/static/admin.html`, embedded with `include_str!`): token box, queue table with pause/resume, job list by state, dead letters with requeue, runs with steps |

Error codes: `validation_failed`, `unauthenticated`, `forbidden`, `not_found`, `unknown_queue`, `invalid_cron`, `invalid_workflow`, `invalid_state`, `workflow_job`, `unique_key_conflict`, `payload_too_large` (`413`), `internal_error`.

There is no broker and no event stream; the jobs table is the queue. The worker has no HTTP surface.

## 7. Loops

Each loop body is a `run_once(now)` function in `engine-store`/`server` that tests call directly; the loop wrapper only sleeps and logs.

| Loop | Binary | Interval | Behaviour and failure semantics |
|---|---|---|---|
| Scheduler | server | 1 s | 5.6. One schedule's failure rolls back its transaction and is retried next pass; an invalid stored expression pauses the schedule and logs an error |
| Reaper | server | 5 s | 5.3; workflow jobs are processed one at a time under the run lock (5.8), others in a batch |
| Purge | server | hourly | 5.9 |
| Clock sync | both | 30 s | Section 2; a failed sync keeps the previous offset |
| Claim loop | worker | 500 ms idle | 5.7; a database error is logged and the loop continues after the poll interval |
| Heartbeats | worker | `lease_seconds / 3` per job | 5.7 |

Server shutdown: stop accepting requests, let in-flight requests and the current loop pass finish, close the pool.

## 8. Edge cases

1. Twenty workers claiming from one queue of 100 jobs: every job is claimed exactly once.
2. Claim order is priority (9 first), then `run_at`, then id; a job with `run_at` in the future is not claimed until then, and is claimable at exactly `run_at`.
3. A claim that finds the first candidates locked by another transaction takes the next ones instead of waiting.
4. A worker stalls past its lease; the reaper requeues the job and a second worker claims it; the first worker's late completion is rejected and the second's result stands.
5. The same, but the first worker finishes before anyone re-claims and before the reaper runs: its completion is accepted.
6. A late heartbeat from a worker whose job was re-claimed returns `LeaseLost` and does not extend the new lease.
7. Completing the same claim twice: the second call is `LeaseLost` and changes nothing.
8. A lease that expires on the last allowed attempt makes the job `dead` with `lease_expired`.
9. Lease validity at exactly `lease_expires_at`: the reaper takes it; one millisecond earlier it does not.
10. A worker whose wall clock is ten minutes fast claims, heartbeats and completes correctly, and does not make other workers' leases look expired.
11. A worker that cannot reach the database stops its handler and abandons the claim before another worker could be running the same job under a new lease.
12. Back-off with base 1 s and `r = 0.5`: attempts 1–5 wait 1, 2, 4, 8, 16 s; attempt 20 waits the cap; a huge attempt number does not overflow.
13. `r = 0` gives 0.8 × and `r → 1` just under 1.2 ×; the cap applies after jitter.
14. `Permanent` on the first attempt goes straight to `dead`; `Retryable` on the last attempt is `dead` with `attempts_exhausted`.
15. A handler panic is retried like a retryable error and does not take the worker down.
16. Enqueue with a `unique_key` held by a `pending` or `running` job returns that job; after it succeeds the same key creates a new job.
17. Fifty concurrent enqueues with one `unique_key` create one job; all callers get the same id.
18. The same `unique_key` on two different queues creates two jobs.
19. Requeueing a dead job whose key is now held by a live job is `409 unique_key_conflict`.
20. Cancel a `pending` job: never runs. Cancel a `running` job: the handler's token fires within one heartbeat interval and the job ends `cancelled`; if the handler ignores the token and succeeds, the job is `succeeded`.
21. Cancel racing with claim on a `pending` job: either it is cancelled and never runs, or it is running with `cancel_requested` set.
22. A cancelled-while-running job whose attempt fails is `cancelled`, not retried; one whose lease expires is `cancelled` by the reaper.
23. `max_concurrency = 2` with five workers: never more than two `running` at once; a slot frees when a job leaves `running`.
24. Rate limit 60/min, burst 10, full bucket: 10 jobs start at once, then one per second; after 5 idle minutes the bucket holds 10, not 300.
25. A `now` earlier than `rate_refilled_at` (clock stepped back) adds no tokens and does not move `rate_refilled_at` backwards.
26. A paused queue: no claims, enqueues accepted, running jobs finish, schedules still add jobs; resume picks them up in order.
27. A job whose kind no worker lists stays `pending` and does not block other jobs in the queue.
28. A schedule `0 */5 * * * *` after 3 hours of downtime: `skip` creates nothing for the missed times and resumes at the next slot; `latest` creates one job for the most recent slot; `all` with `max_catchup = 10` creates the ten most recent, 5 s apart.
29. Two server instances running the scheduler: each fire time creates one job.
30. A fire that is 30 s late is run immediately under every policy; one 61 s late is skipped by `skip`.
31. One hundred schedules due at the same instant after downtime do not all get the same `run_at`.
32. A server down for a week with a per-second schedule and `all`: the pass finishes promptly and creates at most `max_catchup` jobs, none older than the horizon.
33. Pausing and resuming a schedule does not catch up; `next_fire_at` after resume is in the future.
34. An invalid cron expression is `422`; day-of-week names (`Mon-Fri`) are accepted.
35. A diamond workflow (A → B, A → C, B and C → D) where B and C complete in the same instant on two workers: D is enqueued exactly once, with both outputs in `parents`.
36. A step's job completed twice (late duplicate claim) records one output and enqueues children once.
37. A step that fails after exhausting attempts: blocked steps are `skipped`, a sibling still `pending` is `cancelled`, a sibling `running` is asked to cancel, and the run is `failed` only once nothing is `queued`.
38. A sibling that finishes successfully after the run started failing keeps its output; no child is enqueued.
39. Retrying a failed run reruns only failed and cancelled steps; steps that had succeeded are not run again and their outputs feed the retried steps.
40. Cancelling a run with a running step: the run is `cancelled` after that step ends, whatever its outcome.
41. A definition with a cycle, an unknown dependency, a duplicate key or an unknown queue is `422` listing every problem.
42. A workflow whose every step is a root starts all jobs at once and succeeds when all do.
43. Cancel or requeue on a job that belongs to a run is `409 workflow_job`.
44. Worker `SIGTERM` with a 2 s job in flight and a 30 s grace: no new claims, the job finishes and is reported, then the process exits.
45. Worker `SIGTERM` with a job that outlives the grace: its token is cancelled; if it still has not stopped, the claim is released with the attempt count restored and another worker runs it.
46. A released claim whose lease had already been taken over is not released (`LeaseLost`).
47. A payload of 65,537 bytes is `413`; a result over the limit kills the job with `permanent_failure`.
48. A submitter token enqueues only to its queues, cannot start a workflow that touches another queue, and gets `404` for jobs elsewhere.
49. Purge leaves the jobs of a still-running run in place even when they finished long ago.

## 9. Non-goals

Multi-tenancy, workflow definitions as code, conditional branches and loops in workflows, sub-workflows, per-step compensation, time zones for cron (UTC only), job progress reporting, result streaming, a push transport (`LISTEN/NOTIFY`), exactly-once execution, worker auto-scaling, a worker registry, deleting queues, metrics endpoints, a styled UI.

## 10. Acceptance criteria

- A job is never `running` under two valid leases, and a write from a superseded claim never changes a job.
- Every job reaches a terminal state or remains retryable; none is stuck `running` after its worker dies.
- Queue concurrency and rate limits hold with any number of workers.
- Each cron fire time yields at most one job; catch-up follows the schedule's policy and is bounded and spread.
- A workflow step with several parents is enqueued exactly once, after all of them succeed; run state resolves as in 5.8.
- Workers behave correctly with skewed wall clocks, and exit cleanly on `SIGTERM` without losing or stranding jobs.
- All edge cases in section 8 hold.

## 11. Required tests

Unit (`engine-core`, no database):
- Back-off table, jitter bounds, cap, saturation.
- Token bucket refill, burst cap, backward clock.
- Cron planning: due times, each catch-up policy, horizon, misfire grace, spacing and stagger, next fire time.
- DAG validation (each problem kind) and readiness (diamond, chains, all roots).
- Run resolution for every combination of step states; job outcome → next state table including `cancel_requested`.

Database (`#[sqlx::test]`, fixed clock):
- Enqueue: defaults from the queue, unique-key dedupe sequential and concurrent, key reuse after terminal state.
- Claim: ordering, future `run_at`, kinds filter, paused queue, concurrent claimers (tasks on separate connections) with no double claim, concurrency cap, rate limit over simulated time.
- Leases: heartbeat extension, fenced complete/fail/release/heartbeat after re-claim, late completion before re-claim, reaper outcomes at the expiry boundary and on the last attempt.
- Cancellation in each state and racing with claim; requeue rules.
- Scheduler: on-time fire, each catch-up policy after a gap, two concurrent passes, pause/resume, invalid stored expression.
- Workflows: start, linear chain passing outputs, diamond with concurrent parent completion, duplicate completion, failure with skip/cancel, run cancel, run retry, lock ordering under concurrent completion and cancel.
- Purge retention rules.

Worker (database + in-process handlers, paused Tokio time where a duration matters):
- Success, retryable then success, permanent failure, panic.
- Cancellation delivered through heartbeat.
- Abandonment after heartbeat failures (store wrapped to fail).
- Shutdown: finishes within grace; release after grace.
- `http` handler classification against a local axum test server.

API (router with `oneshot`): validation and error envelope, permission matrix per role, submitter queue scoping, pagination.

## 12. Commit plan

1. `chore`: workspace, toolchain, crate skeletons, config, logging, error type and envelope, compose, `.env.example`.
2. `feat`: migrations for queues, jobs, attempts, tokens; `engine-core` states, clock and jitter traits.
3. `feat`: store: queues and enqueue with unique keys; API tokens and auth middleware; queue and job endpoints.
4. `feat`: claim with ordering, concurrency cap and rate limit.
5. `feat`: leases: heartbeat, complete, fail with back-off, release; reaper loop.
6. `feat`: worker binary: claim loop, heartbeat tasks, handler registry and built-in handlers.
7. `feat`: cancellation, dead letters and requeue.
8. `feat`: synced clock and worker abandonment rules.
9. `feat`: cron schedules: planning, scheduler loop, endpoints.
10. `feat`: workflow definitions and validation; starting runs.
11. `feat`: workflow progression: fan-in, failure, cancel, retry.
12. `feat`: graceful shutdown for worker and server; purge loop.
13. `feat`: admin page and stats endpoints.
14. `docs`/`ci`: seed command, README, CI workflow.
