//! Queue definitions and controls.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use engine_core::rate::{refill, Bucket};
use engine_core::state::JobState;
use serde::Serialize;
use sqlx::{PgConnection, PgPool};

use crate::error::is_unique_violation;
use crate::models::{Queue, QUEUE_COLUMNS};
use crate::StoreError;

/// A rate limit expressed as jobs per minute with a burst size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimit {
    pub per_minute: i32,
    pub burst: i32,
}

/// Fields of a queue to create. Ranges are validated by the caller and by the schema.
#[derive(Debug, Clone)]
pub struct NewQueue {
    pub name: String,
    pub max_concurrency: Option<i32>,
    pub rate_limit: Option<RateLimit>,
    pub default_max_attempts: i32,
    pub default_lease_seconds: i32,
    pub backoff_base_ms: i64,
    pub backoff_cap_ms: i64,
}

/// Changes to a queue. `None` leaves a field unchanged; `Some(None)` clears an optional field.
#[derive(Debug, Clone, Default)]
pub struct QueuePatch {
    pub max_concurrency: Option<Option<i32>>,
    pub rate_limit: Option<Option<RateLimit>>,
    pub default_max_attempts: Option<i32>,
    pub default_lease_seconds: Option<i32>,
    pub backoff_base_ms: Option<i64>,
    pub backoff_cap_ms: Option<i64>,
}

/// Creates a queue. A full rate-limit bucket is granted when a rate limit is set.
pub async fn create_queue(
    pool: &PgPool,
    new: &NewQueue,
    now: DateTime<Utc>,
) -> Result<Queue, StoreError> {
    let tokens = new
        .rate_limit
        .map(|r| i64::from(r.burst) * 1000)
        .unwrap_or(0);
    let sql = format!(
        "INSERT INTO queues (name, max_concurrency, rate_limit_per_minute, rate_burst, \
         rate_tokens_milli, rate_refilled_at, default_max_attempts, default_lease_seconds, \
         backoff_base_ms, backoff_cap_ms, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $6) RETURNING {QUEUE_COLUMNS}"
    );
    let result = sqlx::query_as::<_, Queue>(&sql)
        .bind(&new.name)
        .bind(new.max_concurrency)
        .bind(new.rate_limit.map(|r| r.per_minute))
        .bind(new.rate_limit.map(|r| r.burst))
        .bind(tokens)
        .bind(now)
        .bind(new.default_max_attempts)
        .bind(new.default_lease_seconds)
        .bind(new.backoff_base_ms)
        .bind(new.backoff_cap_ms)
        .fetch_one(pool)
        .await;
    match result {
        Ok(queue) => Ok(queue),
        Err(err) if is_unique_violation(&err, "queues_pkey") => Err(StoreError::InvalidState(
            "A queue with this name already exists.".to_string(),
        )),
        Err(err) => Err(err.into()),
    }
}

/// Loads a queue by name.
pub async fn get_queue(pool: &PgPool, name: &str) -> Result<Queue, StoreError> {
    let mut conn = pool.acquire().await?;
    find_queue(&mut conn, name)
        .await?
        .ok_or(StoreError::NotFound)
}

pub(crate) async fn find_queue(
    conn: &mut PgConnection,
    name: &str,
) -> Result<Option<Queue>, StoreError> {
    let sql = format!("SELECT {QUEUE_COLUMNS} FROM queues WHERE name = $1");
    let queue = sqlx::query_as::<_, Queue>(&sql)
        .bind(name)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(queue)
}

/// Lists queues ordered by name, starting after `after`, optionally limited to `only`.
pub async fn list_queues(
    pool: &PgPool,
    after: Option<&str>,
    limit: i64,
    only: Option<&[String]>,
) -> Result<Vec<Queue>, StoreError> {
    let sql = format!(
        "SELECT {QUEUE_COLUMNS} FROM queues \
         WHERE ($1::text IS NULL OR name > $1) AND ($2::text[] IS NULL OR name = ANY($2)) \
         ORDER BY name LIMIT $3"
    );
    let queues = sqlx::query_as::<_, Queue>(&sql)
        .bind(after)
        .bind(only.map(|q| q.to_vec()))
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(queues)
}

/// Returns how many jobs of `queue` are running under a lease that has not run out at `now`.
pub(crate) async fn running_jobs(
    conn: &mut PgConnection,
    queue: &str,
    now: DateTime<Utc>,
) -> Result<i64, StoreError> {
    let running = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM jobs \
         WHERE queue = $1 AND state = 'running' AND lease_expires_at > $2",
    )
    .bind(queue)
    .bind(now)
    .fetch_one(&mut *conn)
    .await?;
    Ok(running)
}

/// Refills a rate-limited queue's token bucket up to `now`, stores it and returns it. Returns
/// `None` for a queue without a rate limit.
pub(crate) async fn refill_bucket(
    conn: &mut PgConnection,
    queue: &Queue,
    now: DateTime<Utc>,
) -> Result<Option<Bucket>, StoreError> {
    let (Some(per_minute), Some(burst)) = (queue.rate_limit_per_minute, queue.rate_burst) else {
        return Ok(None);
    };
    let stored = Bucket {
        tokens_milli: queue.rate_tokens_milli,
        refilled_at: queue.rate_refilled_at,
    };
    let refilled = refill(stored, per_minute, burst, now);
    if refilled != stored {
        save_bucket(conn, &queue.name, refilled).await?;
    }
    Ok(Some(refilled))
}

/// Stores the token bucket of the queue `name`.
pub(crate) async fn save_bucket(
    conn: &mut PgConnection,
    name: &str,
    bucket: Bucket,
) -> Result<(), StoreError> {
    sqlx::query("UPDATE queues SET rate_tokens_milli = $2, rate_refilled_at = $3 WHERE name = $1")
        .bind(name)
        .bind(bucket.tokens_milli)
        .bind(bucket.refilled_at)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Returns the names of the queues among `names` that exist.
pub async fn existing_queue_names(
    conn: &mut PgConnection,
    names: &[String],
) -> Result<Vec<String>, StoreError> {
    let found = sqlx::query_scalar::<_, String>("SELECT name FROM queues WHERE name = ANY($1)")
        .bind(names.to_vec())
        .fetch_all(&mut *conn)
        .await?;
    Ok(found)
}

/// Applies `patch` to a queue and returns the updated queue.
///
/// Setting a rate limit refills the bucket to the burst size as of `now`.
pub async fn update_queue(
    pool: &PgPool,
    name: &str,
    patch: &QueuePatch,
    now: DateTime<Utc>,
) -> Result<Queue, StoreError> {
    let mut tx = pool.begin().await?;
    let sql = format!("SELECT {QUEUE_COLUMNS} FROM queues WHERE name = $1 FOR UPDATE");
    let mut queue = sqlx::query_as::<_, Queue>(&sql)
        .bind(name)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::NotFound)?;

    if let Some(max_concurrency) = patch.max_concurrency {
        queue.max_concurrency = max_concurrency;
    }
    if let Some(rate_limit) = patch.rate_limit {
        queue.rate_limit_per_minute = rate_limit.map(|r| r.per_minute);
        queue.rate_burst = rate_limit.map(|r| r.burst);
        queue.rate_tokens_milli = rate_limit.map(|r| i64::from(r.burst) * 1000).unwrap_or(0);
        queue.rate_refilled_at = now;
    }
    if let Some(v) = patch.default_max_attempts {
        queue.default_max_attempts = v;
    }
    if let Some(v) = patch.default_lease_seconds {
        queue.default_lease_seconds = v;
    }
    if let Some(v) = patch.backoff_base_ms {
        queue.backoff_base_ms = v;
    }
    if let Some(v) = patch.backoff_cap_ms {
        queue.backoff_cap_ms = v;
    }
    if queue.backoff_cap_ms < queue.backoff_base_ms {
        return Err(StoreError::Conflict {
            field: "backoff_cap_ms".to_string(),
            message: "must be at least backoff_base_ms".to_string(),
        });
    }

    let sql = format!(
        "UPDATE queues SET max_concurrency = $2, rate_limit_per_minute = $3, rate_burst = $4, \
         rate_tokens_milli = $5, rate_refilled_at = $6, default_max_attempts = $7, \
         default_lease_seconds = $8, backoff_base_ms = $9, backoff_cap_ms = $10 \
         WHERE name = $1 RETURNING {QUEUE_COLUMNS}"
    );
    let updated = sqlx::query_as::<_, Queue>(&sql)
        .bind(name)
        .bind(queue.max_concurrency)
        .bind(queue.rate_limit_per_minute)
        .bind(queue.rate_burst)
        .bind(queue.rate_tokens_milli)
        .bind(queue.rate_refilled_at)
        .bind(queue.default_max_attempts)
        .bind(queue.default_lease_seconds)
        .bind(queue.backoff_base_ms)
        .bind(queue.backoff_cap_ms)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(updated)
}

/// Pauses or resumes a queue and returns it.
pub async fn set_queue_paused(
    pool: &PgPool,
    name: &str,
    paused: bool,
) -> Result<Queue, StoreError> {
    let sql = format!("UPDATE queues SET paused = $2 WHERE name = $1 RETURNING {QUEUE_COLUMNS}");
    sqlx::query_as::<_, Queue>(&sql)
        .bind(name)
        .bind(paused)
        .fetch_optional(pool)
        .await?
        .ok_or(StoreError::NotFound)
}

/// Job counts and limits for one queue.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueueStats {
    pub queue: String,
    pub paused: bool,
    /// Number of jobs in each state, including states with no jobs.
    pub counts: BTreeMap<String, i64>,
    pub oldest_pending_run_at: Option<DateTime<Utc>>,
    /// Concurrency slots free as of now, when the queue has a concurrency cap.
    pub free_slots: Option<i64>,
    /// Whole tokens in the rate-limit bucket as of now, when the queue has a rate limit.
    pub tokens_available: Option<i64>,
}

/// Returns the job counts of a queue, its oldest pending `run_at`, its free concurrency slots
/// and its available tokens.
pub async fn queue_stats(
    pool: &PgPool,
    name: &str,
    now: DateTime<Utc>,
) -> Result<QueueStats, StoreError> {
    let mut conn = pool.acquire().await?;
    let queue = find_queue(&mut conn, name)
        .await?
        .ok_or(StoreError::NotFound)?;
    let mut counts: BTreeMap<String, i64> = JobState::ALL
        .iter()
        .map(|s| (s.as_str().to_string(), 0))
        .collect();
    let rows = sqlx::query_as::<_, (String, i64)>(
        "SELECT state, count(*) FROM jobs WHERE queue = $1 GROUP BY state",
    )
    .bind(name)
    .fetch_all(&mut *conn)
    .await?;
    for (state, count) in rows {
        counts.insert(state, count);
    }
    let oldest_pending_run_at = sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
        "SELECT min(run_at) FROM jobs WHERE queue = $1 AND state = 'pending'",
    )
    .bind(name)
    .fetch_one(&mut *conn)
    .await?;
    let free_slots = match queue.max_concurrency {
        Some(max) => {
            let running = running_jobs(&mut conn, name, now).await?;
            Some((i64::from(max) - running).max(0))
        }
        None => None,
    };
    let tokens_available = refill_bucket(&mut conn, &queue, now)
        .await?
        .map(|bucket| bucket.tokens_milli / 1000);
    Ok(QueueStats {
        queue: queue.name,
        paused: queue.paused,
        counts,
        oldest_pending_run_at,
        free_slots,
        tokens_available,
    })
}
