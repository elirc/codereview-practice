//! Queue definitions and controls.

use chrono::{DateTime, Utc};
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
        Err(err) if is_unique_violation(&err, "queues_pkey") => Err(StoreError::Conflict {
            field: "name".to_string(),
            message: "a queue with this name already exists".to_string(),
        }),
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
