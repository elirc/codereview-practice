//! Writes a worker makes about a job it has claimed, and the shared helpers that end a claim.

use chrono::{DateTime, Utc};
use engine_core::backoff::backoff;
use engine_core::clock::JitterSource;
use engine_core::limits::{json_size, truncate_error, MAX_RESULT_BYTES};
use engine_core::outcome::{decide_failure, FailureKind, NextState, RESULT_TOO_LARGE};
use engine_core::state::{AttemptOutcome, JobState};
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::claim::ClaimRef;
use crate::StoreError;

/// What [`complete`] recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completion {
    Succeeded,
    /// The result exceeded the size limit and the job was killed instead.
    ResultTooLarge,
}

/// Columns needed to decide how a running job ends.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct RunningJob {
    pub id: Uuid,
    pub lease_epoch: i64,
    pub attempt: i32,
    pub max_attempts: i32,
    pub cancel_requested: bool,
    pub backoff_base_ms: i64,
    pub backoff_cap_ms: i64,
    pub workflow_run_id: Option<Uuid>,
    pub step_key: Option<String>,
}

pub(crate) const RUNNING_JOB_COLUMNS: &str = "j.id, j.lease_epoch, j.attempt, j.max_attempts, \
     j.cancel_requested, q.backoff_base_ms, q.backoff_cap_ms, j.workflow_run_id, j.step_key";

/// Extends the lease of a claim and returns whether cancellation has been requested.
pub async fn heartbeat(
    pool: &PgPool,
    claim: &ClaimRef,
    now: DateTime<Utc>,
) -> Result<bool, StoreError> {
    let cancel_requested = sqlx::query_scalar::<_, bool>(
        "UPDATE jobs SET lease_expires_at = $3 + lease_seconds * interval '1 second', \
         heartbeat_at = $3 \
         WHERE id = $1 AND lease_epoch = $2 AND state = 'running' \
         RETURNING cancel_requested",
    )
    .bind(claim.job_id)
    .bind(claim.lease_epoch)
    .bind(now)
    .fetch_optional(pool)
    .await?;
    cancel_requested.ok_or(StoreError::LeaseLost)
}

/// Records a successful result for a claim.
///
/// A result larger than the limit is recorded as a permanent failure instead.
pub async fn complete(
    pool: &PgPool,
    claim: &ClaimRef,
    result: &Value,
    now: DateTime<Utc>,
) -> Result<Completion, StoreError> {
    if json_size(result) > MAX_RESULT_BYTES {
        let mut tx = pool.begin().await?;
        fail_on(
            &mut tx,
            claim,
            FailureKind::Permanent,
            RESULT_TOO_LARGE,
            now,
            0.0,
        )
        .await?;
        tx.commit().await?;
        return Ok(Completion::ResultTooLarge);
    }
    let mut tx = pool.begin().await?;
    let updated = sqlx::query_scalar::<_, Uuid>(
        "UPDATE jobs SET state = 'succeeded', result = $3, finished_at = $4, \
         lease_owner = NULL, lease_expires_at = NULL \
         WHERE id = $1 AND lease_epoch = $2 AND state = 'running' \
         RETURNING id",
    )
    .bind(claim.job_id)
    .bind(claim.lease_epoch)
    .bind(result)
    .bind(now)
    .fetch_optional(&mut *tx)
    .await?;
    if updated.is_none() {
        return Err(StoreError::LeaseLost);
    }
    close_attempt(
        &mut tx,
        claim.job_id,
        claim.lease_epoch,
        AttemptOutcome::Succeeded,
        None,
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(Completion::Succeeded)
}

/// Records a handler error for a claim and returns the job's new state.
pub async fn fail(
    pool: &PgPool,
    claim: &ClaimRef,
    kind: FailureKind,
    message: &str,
    now: DateTime<Utc>,
    jitter: &dyn JitterSource,
) -> Result<JobState, StoreError> {
    let mut tx = pool.begin().await?;
    let state = fail_on(&mut tx, claim, kind, message, now, jitter.sample()).await?;
    tx.commit().await?;
    Ok(state)
}

async fn fail_on(
    conn: &mut PgConnection,
    claim: &ClaimRef,
    kind: FailureKind,
    message: &str,
    now: DateTime<Utc>,
    r: f64,
) -> Result<JobState, StoreError> {
    let job = lock_running(conn, claim).await?;
    let decision = decide_failure(
        kind,
        message,
        job.cancel_requested,
        job.attempt,
        job.max_attempts,
    );
    let retry_at = now + backoff(job.attempt, job.backoff_base_ms, job.backoff_cap_ms, r);
    end_claim(
        conn,
        &job,
        decision.next,
        retry_at,
        Some(&decision.message),
        now,
    )
    .await?;
    close_attempt(
        conn,
        job.id,
        job.lease_epoch,
        decision.attempt_outcome,
        Some(&decision.message),
        now,
    )
    .await?;
    Ok(decision.next.job_state())
}

/// Gives a claim back without using up an attempt. The job becomes due at `now`, or
/// `cancelled` when cancellation has been requested.
pub async fn release(
    pool: &PgPool,
    claim: &ClaimRef,
    now: DateTime<Utc>,
) -> Result<JobState, StoreError> {
    let mut tx = pool.begin().await?;
    let job = lock_running(&mut tx, claim).await?;
    let (state, outcome) = if job.cancel_requested {
        sqlx::query(
            "UPDATE jobs SET state = 'cancelled', finished_at = $3, attempt = attempt - 1, \
             lease_owner = NULL, lease_expires_at = NULL \
             WHERE id = $1 AND lease_epoch = $2 AND state = 'running'",
        )
        .bind(job.id)
        .bind(job.lease_epoch)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        (JobState::Cancelled, AttemptOutcome::Cancelled)
    } else {
        sqlx::query(
            "UPDATE jobs SET state = 'pending', run_at = $3, attempt = attempt - 1, \
             lease_owner = NULL, lease_expires_at = NULL \
             WHERE id = $1 AND lease_epoch = $2 AND state = 'running'",
        )
        .bind(job.id)
        .bind(job.lease_epoch)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        (JobState::Pending, AttemptOutcome::Released)
    };
    close_attempt(&mut tx, job.id, job.lease_epoch, outcome, None, now).await?;
    tx.commit().await?;
    Ok(state)
}

/// Locks the job of a claim if the claim still holds it.
pub(crate) async fn lock_running(
    conn: &mut PgConnection,
    claim: &ClaimRef,
) -> Result<RunningJob, StoreError> {
    let sql = format!(
        "SELECT {RUNNING_JOB_COLUMNS} FROM jobs j JOIN queues q ON q.name = j.queue \
         WHERE j.id = $1 AND j.lease_epoch = $2 AND j.state = 'running' \
         FOR UPDATE OF j"
    );
    sqlx::query_as::<_, RunningJob>(&sql)
        .bind(claim.job_id)
        .bind(claim.lease_epoch)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or(StoreError::LeaseLost)
}

/// Moves a running job to `next`, clearing its lease. A retry becomes due at `retry_at`.
pub(crate) async fn end_claim(
    conn: &mut PgConnection,
    job: &RunningJob,
    next: NextState,
    retry_at: DateTime<Utc>,
    error: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), StoreError> {
    let state = next.job_state();
    let finished_at = if state.is_terminal() { Some(now) } else { None };
    let result = sqlx::query(
        "UPDATE jobs SET state = $3, \
             run_at = CASE WHEN $3 = 'pending' THEN $4 ELSE run_at END, \
             dead_reason = $5, last_error = COALESCE($6, last_error), finished_at = $7, \
             lease_owner = NULL, lease_expires_at = NULL \
         WHERE id = $1 AND lease_epoch = $2 AND state = 'running'",
    )
    .bind(job.id)
    .bind(job.lease_epoch)
    .bind(state.as_str())
    .bind(retry_at)
    .bind(next.dead_reason().map(|r| r.as_str()))
    .bind(error.map(truncate_error))
    .bind(finished_at)
    .execute(&mut *conn)
    .await?;
    if result.rows_affected() == 0 {
        return Err(StoreError::LeaseLost);
    }
    Ok(())
}

/// Records how an attempt ended.
pub(crate) async fn close_attempt(
    conn: &mut PgConnection,
    job_id: Uuid,
    lease_epoch: i64,
    outcome: AttemptOutcome,
    error: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), StoreError> {
    sqlx::query(
        "UPDATE job_attempts SET finished_at = $3, outcome = $4, error = $5 \
         WHERE job_id = $1 AND lease_epoch = $2",
    )
    .bind(job_id)
    .bind(lease_epoch)
    .bind(now)
    .bind(outcome.as_str())
    .bind(error.map(truncate_error))
    .execute(&mut *conn)
    .await?;
    Ok(())
}
