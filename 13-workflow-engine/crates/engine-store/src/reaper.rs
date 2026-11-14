//! Ending claims whose lease has run out.

use chrono::{DateTime, Utc};
use engine_core::backoff::backoff;
use engine_core::clock::JitterSource;
use engine_core::outcome::decide_lease_expiry;
use engine_core::state::AttemptOutcome;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::lease::{after_job_end, close_attempt, end_claim, RunningJob, RUNNING_JOB_COLUMNS};
use crate::progress::lock_run;
use crate::StoreError;

/// Largest number of jobs handled in one pass, for each of standalone and workflow jobs.
pub const REAP_BATCH: i64 = 100;

/// Ends claims whose lease expired at or before `now` and returns how many were ended. Each
/// job is cancelled, killed or scheduled for a retry.
pub async fn reap_expired(
    pool: &PgPool,
    now: DateTime<Utc>,
    jitter: &dyn JitterSource,
) -> Result<usize, StoreError> {
    let standalone = reap_standalone(pool, now, jitter).await?;
    let in_runs = reap_workflow_jobs(pool, now, jitter).await?;
    Ok(standalone + in_runs)
}

async fn reap_standalone(
    pool: &PgPool,
    now: DateTime<Utc>,
    jitter: &dyn JitterSource,
) -> Result<usize, StoreError> {
    let mut tx = pool.begin().await?;
    let sql = format!(
        "SELECT {RUNNING_JOB_COLUMNS} FROM jobs j JOIN queues q ON q.name = j.queue \
         WHERE j.state = 'running' AND j.lease_expires_at <= $1 \
           AND j.workflow_run_id IS NULL \
         ORDER BY j.lease_expires_at \
         LIMIT $2 \
         FOR UPDATE OF j SKIP LOCKED"
    );
    let expired = sqlx::query_as::<_, RunningJob>(&sql)
        .bind(now)
        .bind(REAP_BATCH)
        .fetch_all(&mut *tx)
        .await?;
    for job in &expired {
        expire(&mut tx, job, now, jitter.sample()).await?;
    }
    tx.commit().await?;
    Ok(expired.len())
}

async fn reap_workflow_jobs(
    pool: &PgPool,
    now: DateTime<Utc>,
    jitter: &dyn JitterSource,
) -> Result<usize, StoreError> {
    let candidates = sqlx::query_as::<_, (Uuid, i64, Uuid)>(
        "SELECT id, lease_epoch, workflow_run_id FROM jobs \
         WHERE state = 'running' AND lease_expires_at <= $1 AND workflow_run_id IS NOT NULL \
         ORDER BY lease_expires_at LIMIT $2",
    )
    .bind(now)
    .bind(REAP_BATCH)
    .fetch_all(pool)
    .await?;

    let sql = format!(
        "SELECT {RUNNING_JOB_COLUMNS} FROM jobs j JOIN queues q ON q.name = j.queue \
         WHERE j.id = $1 AND j.lease_epoch = $2 AND j.state = 'running' \
           AND j.lease_expires_at <= $3 \
         FOR UPDATE OF j"
    );
    let mut reaped = 0;
    for (job_id, lease_epoch, run_id) in candidates {
        let mut tx = pool.begin().await?;
        if lock_run(&mut tx, run_id).await?.is_none() {
            continue;
        }
        let job = sqlx::query_as::<_, RunningJob>(&sql)
            .bind(job_id)
            .bind(lease_epoch)
            .bind(now)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(job) = job {
            expire(&mut tx, &job, now, jitter.sample()).await?;
            reaped += 1;
        }
        tx.commit().await?;
    }
    Ok(reaped)
}

async fn expire(
    conn: &mut PgConnection,
    job: &RunningJob,
    now: DateTime<Utc>,
    r: f64,
) -> Result<(), StoreError> {
    let next = decide_lease_expiry(job.cancel_requested, job.attempt, job.max_attempts);
    let retry_at = now + backoff(job.attempt, job.backoff_base_ms, job.backoff_cap_ms, r);
    close_attempt(
        conn,
        job.id,
        job.lease_epoch,
        AttemptOutcome::LeaseExpired,
        Some("lease expired"),
        now,
    )
    .await?;
    end_claim(conn, job, next, retry_at, Some("lease expired"), now).await?;
    after_job_end(conn, job, next.job_state(), now).await?;
    tracing::info!(
        job_id = %job.id,
        attempt = job.attempt,
        next_state = next.job_state().as_str(),
        "expired lease ended"
    );
    Ok(())
}
