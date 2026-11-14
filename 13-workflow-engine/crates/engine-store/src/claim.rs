//! Claiming pending jobs for a worker.

use chrono::{DateTime, Utc};
use engine_core::rate::{allowance, consume, refill, Bucket};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::models::{Queue, QUEUE_COLUMNS};
use crate::queues::find_queue;
use crate::StoreError;

/// Identifies one claim of a job: the job and the lease epoch it was claimed under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimRef {
    pub job_id: Uuid,
    pub lease_epoch: i64,
    pub workflow_run_id: Option<Uuid>,
}

/// A job claimed by a worker, with what the worker needs to run it.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct ClaimedJob {
    pub id: Uuid,
    pub queue: String,
    pub kind: String,
    pub payload: Value,
    pub priority: i32,
    pub run_at: DateTime<Utc>,
    pub attempt: i32,
    pub max_attempts: i32,
    pub lease_seconds: i32,
    pub lease_epoch: i64,
    pub lease_expires_at: DateTime<Utc>,
    pub workflow_run_id: Option<Uuid>,
    pub step_key: Option<String>,
}

impl ClaimedJob {
    /// Returns the reference used for every later write about this claim.
    pub fn claim_ref(&self) -> ClaimRef {
        ClaimRef {
            job_id: self.id,
            lease_epoch: self.lease_epoch,
            workflow_run_id: self.workflow_run_id,
        }
    }
}

/// Claims up to `limit` due jobs of the given `kinds` from `queue` for `worker_id`.
///
/// Returns nothing for a paused queue. The number claimed is further limited by the queue's
/// concurrency cap and rate limit. Claimed jobs are returned in claim order: priority
/// (highest first), then `run_at`, then id.
pub async fn claim(
    pool: &PgPool,
    queue: &str,
    kinds: &[String],
    worker_id: &str,
    limit: i64,
    now: DateTime<Utc>,
) -> Result<Vec<ClaimedJob>, StoreError> {
    if limit <= 0 || kinds.is_empty() {
        return Ok(Vec::new());
    }
    let mut tx = pool.begin().await?;
    let unlocked = find_queue(&mut tx, queue)
        .await?
        .ok_or_else(|| StoreError::UnknownQueue(queue.to_string()))?;
    if unlocked.paused {
        return Ok(Vec::new());
    }
    let limited = unlocked.max_concurrency.is_some() || unlocked.rate_limit_per_minute.is_some();
    let q: Queue = if limited {
        let sql = format!("SELECT {QUEUE_COLUMNS} FROM queues WHERE name = $1 FOR NO KEY UPDATE");
        sqlx::query_as::<_, Queue>(&sql)
            .bind(queue)
            .fetch_one(&mut *tx)
            .await?
    } else {
        unlocked
    };
    if q.paused {
        return Ok(Vec::new());
    }

    let running = match q.max_concurrency {
        Some(_) => {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM jobs WHERE queue = $1 AND state = 'running'",
            )
            .bind(queue)
            .fetch_one(&mut *tx)
            .await?
        }
        None => 0,
    };
    let bucket = match (q.rate_limit_per_minute, q.rate_burst) {
        (Some(per_minute), Some(burst)) => Some(refill(
            Bucket {
                tokens_milli: q.rate_tokens_milli,
                refilled_at: q.rate_refilled_at,
            },
            per_minute,
            burst,
            now,
        )),
        _ => None,
    };
    let allowed = allowance(
        limit,
        q.max_concurrency,
        running,
        bucket.map(|b| b.tokens_milli),
    );

    let mut claimed = if allowed > 0 {
        sqlx::query_as::<_, ClaimedJob>(
            "WITH candidates AS ( \
                 SELECT id FROM jobs \
                 WHERE queue = $1 AND state = 'pending' AND run_at <= $2 \
                   AND kind = ANY($3) AND NOT cancel_requested \
                 ORDER BY priority DESC, run_at, id \
                 LIMIT $4 \
                 FOR UPDATE SKIP LOCKED \
             ) \
             UPDATE jobs j SET state = 'running', attempt = j.attempt + 1, \
                 lease_epoch = j.lease_epoch + 1, lease_owner = $5, \
                 lease_expires_at = $2 + j.lease_seconds * interval '1 second', \
                 heartbeat_at = $2, started_at = $2 \
             FROM candidates c WHERE j.id = c.id \
             RETURNING j.id, j.queue, j.kind, j.payload, j.priority, j.run_at, j.attempt, \
                 j.max_attempts, j.lease_seconds, j.lease_epoch, j.lease_expires_at, \
                 j.workflow_run_id, j.step_key",
        )
        .bind(queue)
        .bind(now)
        .bind(kinds)
        .bind(allowed)
        .bind(worker_id)
        .fetch_all(&mut *tx)
        .await?
    } else {
        Vec::new()
    };
    claimed.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then(a.run_at.cmp(&b.run_at))
            .then(a.id.cmp(&b.id))
    });

    for job in &claimed {
        sqlx::query(
            "INSERT INTO job_attempts (job_id, attempt, lease_epoch, worker_id, started_at) \
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(job.id)
        .bind(job.attempt)
        .bind(job.lease_epoch)
        .bind(worker_id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }

    if let Some(refilled) = bucket {
        let remaining = consume(refilled, claimed.len() as i64);
        sqlx::query(
            "UPDATE queues SET rate_tokens_milli = $2, rate_refilled_at = $3 WHERE name = $1",
        )
        .bind(queue)
        .bind(remaining.tokens_milli)
        .bind(remaining.refilled_at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(claimed)
}
