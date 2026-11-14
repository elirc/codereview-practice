//! Enqueueing, reading and listing jobs.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::models::{Job, JobAttempt, JOB_COLUMNS};
use crate::page::TimeCursor;
use crate::StoreError;

/// A job to enqueue. Omitted limits are taken from the queue.
#[derive(Debug, Clone)]
pub struct NewJob {
    pub queue: String,
    pub kind: String,
    pub payload: Value,
    pub priority: i32,
    pub run_at: DateTime<Utc>,
    pub max_attempts: Option<i32>,
    pub lease_seconds: Option<i32>,
    pub unique_key: Option<String>,
    pub schedule_id: Option<Uuid>,
    pub scheduled_for: Option<DateTime<Utc>>,
    pub created_by_token_id: Option<Uuid>,
}

impl NewJob {
    /// Creates a job for `queue` and `kind` with default priority, due at `run_at`.
    pub fn new(queue: &str, kind: &str, payload: Value, run_at: DateTime<Utc>) -> Self {
        Self {
            queue: queue.to_string(),
            kind: kind.to_string(),
            payload,
            priority: 5,
            run_at,
            max_attempts: None,
            lease_seconds: None,
            unique_key: None,
            schedule_id: None,
            scheduled_for: None,
            created_by_token_id: None,
        }
    }
}

/// Result of [`enqueue`]: the job, and whether an existing live job was returned instead.
#[derive(Debug, Clone)]
pub struct Enqueued {
    pub job: Job,
    pub deduplicated: bool,
}

/// Filters for [`list_jobs`].
#[derive(Debug, Clone, Default)]
pub struct JobFilter {
    pub queue: Option<String>,
    pub state: Option<String>,
    pub kind: Option<String>,
    /// Restricts the listing to these queues when set.
    pub within_queues: Option<Vec<String>>,
}

/// Enqueues a job, or returns the live job that already holds its unique key.
pub async fn enqueue(
    pool: &PgPool,
    new: &NewJob,
    now: DateTime<Utc>,
) -> Result<Enqueued, StoreError> {
    let mut conn = pool.acquire().await?;
    enqueue_on(&mut conn, new, now).await
}

/// Same as [`enqueue`], on an existing connection or transaction.
pub async fn enqueue_on(
    conn: &mut PgConnection,
    new: &NewJob,
    now: DateTime<Utc>,
) -> Result<Enqueued, StoreError> {
    let defaults = sqlx::query_as::<_, (i32, i32)>(
        "SELECT default_max_attempts, default_lease_seconds FROM queues WHERE name = $1",
    )
    .bind(&new.queue)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| StoreError::UnknownQueue(new.queue.clone()))?;
    let max_attempts = new.max_attempts.unwrap_or(defaults.0);
    let lease_seconds = new.lease_seconds.unwrap_or(defaults.1);
    let run_at = new.run_at.max(now);

    let insert = format!(
        "INSERT INTO jobs (id, queue, kind, payload, priority, state, run_at, max_attempts, \
         lease_seconds, unique_key, schedule_id, scheduled_for, created_by_token_id, created_at) \
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12, $13) \
         ON CONFLICT (queue, unique_key) \
         WHERE unique_key IS NOT NULL AND state IN ('pending', 'running') DO NOTHING \
         RETURNING {JOB_COLUMNS}"
    );
    let existing = format!(
        "SELECT {JOB_COLUMNS} FROM jobs WHERE queue = $1 AND unique_key = $2 \
         AND state IN ('pending', 'running')"
    );

    for _ in 0..2 {
        let inserted = sqlx::query_as::<_, Job>(&insert)
            .bind(Uuid::new_v4())
            .bind(&new.queue)
            .bind(&new.kind)
            .bind(&new.payload)
            .bind(new.priority)
            .bind(run_at)
            .bind(max_attempts)
            .bind(lease_seconds)
            .bind(&new.unique_key)
            .bind(new.schedule_id)
            .bind(new.scheduled_for)
            .bind(new.created_by_token_id)
            .bind(now)
            .fetch_optional(&mut *conn)
            .await?;
        if let Some(job) = inserted {
            return Ok(Enqueued {
                job,
                deduplicated: false,
            });
        }
        let Some(key) = &new.unique_key else {
            return Err(StoreError::Corrupt(
                "insert without a unique key returned no row".to_string(),
            ));
        };
        let holder = sqlx::query_as::<_, Job>(&existing)
            .bind(&new.queue)
            .bind(key)
            .fetch_optional(&mut *conn)
            .await?;
        if let Some(job) = holder {
            return Ok(Enqueued {
                job,
                deduplicated: true,
            });
        }
    }
    Err(StoreError::UniqueKeyConflict)
}

/// Loads a job by id.
pub async fn get_job(pool: &PgPool, id: Uuid) -> Result<Job, StoreError> {
    let sql = format!("SELECT {JOB_COLUMNS} FROM jobs WHERE id = $1");
    sqlx::query_as::<_, Job>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(StoreError::NotFound)
}

/// Lists the attempts of a job, oldest first.
pub async fn list_attempts(pool: &PgPool, job_id: Uuid) -> Result<Vec<JobAttempt>, StoreError> {
    let attempts = sqlx::query_as::<_, JobAttempt>(
        "SELECT job_id, attempt, lease_epoch, worker_id, started_at, finished_at, outcome, error \
         FROM job_attempts WHERE job_id = $1 ORDER BY lease_epoch",
    )
    .bind(job_id)
    .fetch_all(pool)
    .await?;
    Ok(attempts)
}

/// Lists jobs newest first, starting after `after`, returning at most `limit` rows.
pub async fn list_jobs(
    pool: &PgPool,
    filter: &JobFilter,
    after: Option<TimeCursor>,
    limit: i64,
) -> Result<Vec<Job>, StoreError> {
    let sql = format!(
        "SELECT {JOB_COLUMNS} FROM jobs \
         WHERE ($1::text IS NULL OR queue = $1) \
           AND ($2::text IS NULL OR state = $2) \
           AND ($3::text IS NULL OR kind = $3) \
           AND ($4::text[] IS NULL OR queue = ANY($4)) \
           AND ($5::timestamptz IS NULL OR (created_at, id) < ($5, $6)) \
         ORDER BY created_at DESC, id DESC LIMIT $7"
    );
    let jobs = sqlx::query_as::<_, Job>(&sql)
        .bind(&filter.queue)
        .bind(&filter.state)
        .bind(&filter.kind)
        .bind(&filter.within_queues)
        .bind(after.map(|c| c.created_at))
        .bind(after.map(|c| c.id))
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(jobs)
}
