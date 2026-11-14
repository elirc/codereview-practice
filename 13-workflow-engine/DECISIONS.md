# Decisions

Short records of places where the spec left a choice open.

- **Health route path.** The API table lists `GET /healthz` under the `/api` prefix, while the admin
  page is served at `/`. The health check is served at `/api/healthz`, without authentication.
- **Duplicate names.** No error code is listed for a queue or schedule name that already exists.
  These return `400 validation_failed` with a field error on `name`, the same shape as other
  invalid input.
- **What a submitter may read.** The permission table grants submitters jobs, runs and queues in
  their list. Schedules and workflow definitions are not mentioned, so submitters get
  `403 forbidden` for them; viewers, operators and admins may read them.
- **Queue lists on non-submitter tokens.** Only submitter tokens are limited to queues, so creating
  a viewer, operator or admin token with a non-empty `queues` list is rejected with
  `400 validation_failed` instead of silently ignoring the list.
- **Token bucket remainder.** Applying the refill formula literally and then setting
  `rate_refilled_at = max(rate_refilled_at, now)` throws away the fractional milli-tokens on every
  claim, so a low rate (for example 1 per minute) polled by several workers would never refill.
  The refill advances `rate_refilled_at` only by the time that produced whole milli-tokens, and
  moves it to `now` once the bucket is full. It never moves backwards, and a `now` earlier than
  `rate_refilled_at` adds nothing.
- **Schedules that never fire again.** A seven-field expression with a year can run out of fire
  times. Creating or editing a schedule to such an expression is `422 invalid_cron`; a stored
  schedule that runs out during a pass is paused after its last due fire is handled, because
  `next_fire_at` cannot be empty.
- **Catch-up search start.** When `next_fire_at` is older than the 24-hour horizon, the pass
  searches for fire times from the horizon start rather than from `next_fire_at`, so a long
  outage does not cost one iteration per missed fire.
- **Workflow definition names.** The spec gives no pattern. Names appear in the URL
  `/api/workflow-definitions/{name}`, so they follow the queue-name rule `[a-z0-9_-]{1,64}`.
  Starting a run of a name or version that does not exist is `404 not_found`.
- **Which runs a submitter may see.** A run counts as "in its queues" only when every step of the
  run's definition uses one of the submitter's queues, the same test used to allow starting it.
  Other runs are `404 not_found` and left out of listings.
