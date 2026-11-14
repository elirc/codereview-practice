-- name: TryAdvisoryLock :one
SELECT pg_try_advisory_lock(@lock_key::bigint)::boolean AS acquired;

-- name: AdvisoryUnlock :one
SELECT pg_advisory_unlock(@lock_key::bigint)::boolean AS released;

-- name: FailStaleJobRuns :execrows
UPDATE job_runs
SET status = 'failed', finished_at = @finished_at::timestamptz
WHERE job = @job AND status = 'running';

-- name: CreateJobRun :one
INSERT INTO job_runs (job, as_of, started_at, status)
VALUES ($1, $2, $3, 'running')
RETURNING id, job, as_of, started_at, finished_at, status, leases_processed, entries_posted, errors;

-- name: FinishJobRun :one
UPDATE job_runs
SET status = $2, finished_at = $3, leases_processed = $4, entries_posted = $5, errors = $6
WHERE id = $1
RETURNING id, job, as_of, started_at, finished_at, status, leases_processed, entries_posted, errors;

-- name: HasSuccessfulJobRun :one
SELECT EXISTS (
    SELECT 1
    FROM job_runs
    WHERE job = @job AND as_of = @as_of AND status = 'ok'
)::boolean AS found;

-- name: CountJobRuns :one
SELECT COUNT(*) AS runs
FROM job_runs
WHERE job = $1 AND as_of = $2;

-- name: ListJobRuns :many
SELECT id, job, as_of, started_at, finished_at, status, leases_processed, entries_posted, errors
FROM job_runs
ORDER BY started_at DESC
LIMIT $1;
