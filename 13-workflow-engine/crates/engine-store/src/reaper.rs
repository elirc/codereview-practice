//! Ending claims whose lease has run out.

use chrono::{DateTime, Utc};
use engine_core::backoff::backoff;
use engine_core::clock::JitterSource;
use engine_core::outcome::decide_lease_expiry;
use engine_core::state::AttemptOutcome;
use sqlx::PgPool;

use crate::lease::{close_attempt, end_claim, RunningJob, RUNNING_JOB_COLUMNS};
use crate::StoreError;

/// Largest number of jobs handled in one pass.
pub const REAP_BATCH: i64 = 100;

/// Ends up to [`REAP_BATCH`] claims whose lease expired at or before `now` and returns how
/// many were ended. Each job is cancelled, killed or scheduled for a retry.
pub async fn reap_expired(
    pool: &PgPool,
    now: DateTime<Utc>,
    jitter: &dyn JitterSource,
) -> Result<usize, StoreError> {
    let mut tx = pool.begin().await?;
    let sql = format!(
        "SELECT {RUNNING_JOB_COLUMNS} FROM jobs j JOIN queues q ON q.name = j.queue \
         WHERE j.state = 'running' AND j.lease_expires_at <= $1 \
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

async fn expire(
    conn: &mut sqlx::PgConnection,
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
    tracing::info!(
        job_id = %job.id,
        attempt = job.attempt,
        next_state = next.job_state().as_str(),
        "expired lease ended"
    );
    Ok(())
}
