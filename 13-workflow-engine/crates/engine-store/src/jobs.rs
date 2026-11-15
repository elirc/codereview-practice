//! Enqueueing, reading, listing, cancelling and requeueing jobs.

use std::collections::{BTreeSet, HashMap};

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::error::is_unique_violation;
use crate::models::{Job, JobAttempt, JOB_COLUMNS};
use crate::page::TimeCursor;
use crate::StoreError;

/// Largest number of jobs [`enqueue_batch`] accepts.
pub const MAX_BATCH: usize = 100;

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

/// Enqueues several jobs in one transaction and returns them in request order. A job whose
/// unique key is held by a live job, or by an earlier job of the same batch, returns that job
/// instead.
pub async fn enqueue_batch(
    pool: &PgPool,
    batch: &[NewJob],
    now: DateTime<Utc>,
) -> Result<Vec<Enqueued>, StoreError> {
    let mut tx = pool.begin().await?;

    let names: Vec<String> = batch
        .iter()
        .map(|j| j.queue.clone())
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let defaults: HashMap<String, (i32, i32)> = sqlx::query_as::<_, (String, i32, i32)>(
        "SELECT name, default_max_attempts, default_lease_seconds FROM queues \
         WHERE name = ANY($1)",
    )
    .bind(&names)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(name, attempts, lease)| (name, (attempts, lease)))
    .collect();

    let (key_queues, keys): (Vec<String>, Vec<String>) = batch
        .iter()
        .filter_map(|j| j.unique_key.clone().map(|key| (j.queue.clone(), key)))
        .unzip();
    let mut holders: HashMap<(String, String), Job> = HashMap::new();
    if !keys.is_empty() {
        let live = format!(
            "SELECT {JOB_COLUMNS} FROM jobs WHERE state IN ('pending', 'running') \
             AND (queue, unique_key) IN \
                 (SELECT q, k FROM unnest($1::text[], $2::text[]) AS t(q, k))"
        );
        let rows = sqlx::query_as::<_, Job>(&live)
            .bind(&key_queues)
            .bind(&keys)
            .fetch_all(&mut *tx)
            .await?;
        for job in rows {
            if let Some(key) = job.unique_key.clone() {
                holders.insert((job.queue.clone(), key), job);
            }
        }
    }

    let insert = format!(
        "INSERT INTO jobs (id, queue, kind, payload, priority, state, run_at, max_attempts, \
         lease_seconds, unique_key, schedule_id, scheduled_for, created_by_token_id, created_at) \
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12, $13) \
         RETURNING {JOB_COLUMNS}"
    );
    let mut enqueued = Vec::with_capacity(batch.len());
    for new in batch {
        let (default_attempts, default_lease) = *defaults
            .get(&new.queue)
            .ok_or_else(|| StoreError::UnknownQueue(new.queue.clone()))?;
        let held = new
            .unique_key
            .as_ref()
            .and_then(|key| holders.get(&(new.queue.clone(), key.clone())));
        if let Some(job) = held {
            enqueued.push(Enqueued {
                job: job.clone(),
                deduplicated: true,
            });
            continue;
        }
        let job = sqlx::query_as::<_, Job>(&insert)
            .bind(Uuid::new_v4())
            .bind(&new.queue)
            .bind(&new.kind)
            .bind(&new.payload)
            .bind(new.priority)
            .bind(new.run_at.max(now))
            .bind(new.max_attempts.unwrap_or(default_attempts))
            .bind(new.lease_seconds.unwrap_or(default_lease))
            .bind(&new.unique_key)
            .bind(new.schedule_id)
            .bind(new.scheduled_for)
            .bind(new.created_by_token_id)
            .bind(now)
            .fetch_one(&mut *tx)
            .await
            .map_err(|err| {
                if is_unique_violation(&err, "jobs_live_unique_key") {
                    StoreError::UniqueKeyConflict
                } else {
                    StoreError::from(err)
                }
            })?;
        if let Some(key) = &new.unique_key {
            holders.insert((new.queue.clone(), key.clone()), job.clone());
        }
        enqueued.push(Enqueued {
            job,
            deduplicated: false,
        });
    }
    tx.commit().await?;
    Ok(enqueued)
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

/// Result of [`cancel_job`].
#[derive(Debug, Clone)]
pub struct Cancellation {
    pub job: Job,
    /// True when the job was cancelled at once; false when a running job was asked to stop.
    pub immediate: bool,
}

/// Cancels a pending job, or asks a running job to stop.
///
/// Fails with `WorkflowJob` for jobs that belong to a workflow run and with `InvalidState`
/// for jobs that have already finished.
pub async fn cancel_job(
    pool: &PgPool,
    id: Uuid,
    now: DateTime<Utc>,
) -> Result<Cancellation, StoreError> {
    let mut tx = pool.begin().await?;
    let (state, workflow_run_id) = sqlx::query_as::<_, (String, Option<Uuid>)>(
        "SELECT state, workflow_run_id FROM jobs WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    if workflow_run_id.is_some() {
        return Err(StoreError::WorkflowJob);
    }
    let (updated, immediate) = match state.as_str() {
        "pending" => {
            let sql = format!(
                "UPDATE jobs SET state = 'cancelled', finished_at = $2 \
                 WHERE id = $1 AND state = 'pending' RETURNING {JOB_COLUMNS}"
            );
            let job = sqlx::query_as::<_, Job>(&sql)
                .bind(id)
                .bind(now)
                .fetch_optional(&mut *tx)
                .await?;
            (job, true)
        }
        "running" => {
            let sql = format!(
                "UPDATE jobs SET cancel_requested = true \
                 WHERE id = $1 AND state = 'running' RETURNING {JOB_COLUMNS}"
            );
            let job = sqlx::query_as::<_, Job>(&sql)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
            (job, false)
        }
        other => return Err(StoreError::InvalidState(format!("The job is already {other}."))),
    };
    let job =
        updated.ok_or_else(|| StoreError::Corrupt(format!("job {id} changed while locked")))?;
    tx.commit().await?;
    Ok(Cancellation { job, immediate })
}

/// Puts a dead job back to `pending`, due at `now`, with its attempt count reset.
///
/// Fails with `WorkflowJob` for jobs of a workflow run, `InvalidState` for jobs that are not
/// dead and `UniqueKeyConflict` when another live job holds the same unique key.
pub async fn requeue_job(pool: &PgPool, id: Uuid, now: DateTime<Utc>) -> Result<Job, StoreError> {
    let mut tx = pool.begin().await?;
    let (state, workflow_run_id) = sqlx::query_as::<_, (String, Option<Uuid>)>(
        "SELECT state, workflow_run_id FROM jobs WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    if workflow_run_id.is_some() {
        return Err(StoreError::WorkflowJob);
    }
    if state != "dead" {
        return Err(StoreError::InvalidState(
            "Only dead jobs can be requeued.".to_string(),
        ));
    }
    let job = reset_to_pending(&mut tx, id, now).await?;
    tx.commit().await?;
    Ok(job)
}

/// Resets a finished job to `pending`, due at `now`, keeping its attempt history.
pub(crate) async fn reset_to_pending(
    conn: &mut PgConnection,
    id: Uuid,
    now: DateTime<Utc>,
) -> Result<Job, StoreError> {
    let sql = format!(
        "UPDATE jobs SET state = 'pending', attempt = 0, run_at = $2, cancel_requested = false, \
         last_error = NULL, dead_reason = NULL, result = NULL, finished_at = NULL \
         WHERE id = $1 RETURNING {JOB_COLUMNS}"
    );
    let result = sqlx::query_as::<_, Job>(&sql)
        .bind(id)
        .bind(now)
        .fetch_optional(&mut *conn)
        .await;
    match result {
        Ok(Some(job)) => Ok(job),
        Ok(None) => Err(StoreError::NotFound),
        Err(err) if is_unique_violation(&err, "jobs_live_unique_key") => {
            Err(StoreError::UniqueKeyConflict)
        }
        Err(err) => Err(err.into()),
    }
}
