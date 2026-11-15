use axum::extract::State;
use axum::http::StatusCode;
use axum::{Extension, Json};
use chrono::{DateTime, Duration, Utc};
use engine_core::authz::{Action, Caller};
use engine_core::limits::{json_size, MAX_PAYLOAD_BYTES, MAX_UNIQUE_KEY_CHARS};
use engine_core::names::{is_kind, is_queue_name};
use engine_core::state::JobState;
use engine_store::jobs::{self, JobFilter, NewJob};
use engine_store::models::{Job, JobAttempt};
use engine_store::page::{Page, TimeCursor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::auth::{ensure, ensure_usable, ensure_visible};
use crate::error::{ApiError, FieldError};
use crate::extract::{ApiJson, ApiPath, ApiQuery};
use crate::pagination::{page_limit, time_cursor};
use crate::state::AppState;
use crate::validate::Problems;

/// Furthest in the future a job may be scheduled.
const MAX_SCHEDULE_AHEAD_DAYS: i64 = 365;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnqueueBody {
    queue: String,
    kind: String,
    payload: Value,
    priority: Option<i32>,
    run_at: Option<DateTime<Utc>>,
    delay_seconds: Option<i64>,
    max_attempts: Option<i32>,
    lease_seconds: Option<i32>,
    unique_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchBody {
    jobs: Vec<EnqueueBody>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListJobsQuery {
    queue: Option<String>,
    state: Option<String>,
    kind: Option<String>,
    after: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct EnqueueResponse {
    #[serde(flatten)]
    job: Job,
    deduplicated: bool,
}

#[derive(Debug, Serialize)]
pub struct BatchResponse {
    items: Vec<EnqueueResponse>,
}

#[derive(Debug, Serialize)]
pub struct JobDetail {
    #[serde(flatten)]
    job: Job,
    attempts: Vec<JobAttempt>,
}

/// Validates an enqueue request and converts it into a [`NewJob`] due no earlier than `now`.
pub(crate) fn new_job_from(
    body: EnqueueBody,
    caller: &Caller,
    now: DateTime<Utc>,
) -> Result<NewJob, ApiError> {
    if json_size(&body.payload) > MAX_PAYLOAD_BYTES {
        return Err(ApiError::PayloadTooLarge("payload".to_string()));
    }
    let latest = now + Duration::days(MAX_SCHEDULE_AHEAD_DAYS);
    let mut problems = Problems::new();
    problems.check(is_queue_name(&body.queue), "queue", "must match [a-z0-9_-]{1,64}");
    problems.check(is_kind(&body.kind), "kind", "must match [a-z0-9_.]{1,64}");
    problems.range(body.priority, 0, 9, "priority");
    problems.range(body.max_attempts, 1, 50, "max_attempts");
    problems.range(body.lease_seconds, 5, 3600, "lease_seconds");
    problems.check(
        !(body.run_at.is_some() && body.delay_seconds.is_some()),
        "delay_seconds",
        "give either run_at or delay_seconds, not both",
    );
    problems.range(
        body.delay_seconds,
        0,
        MAX_SCHEDULE_AHEAD_DAYS * 86_400,
        "delay_seconds",
    );
    if let Some(run_at) = body.run_at {
        problems.check(run_at <= latest, "run_at", "must be at most one year ahead");
    }
    if let Some(key) = &body.unique_key {
        let len = key.chars().count();
        problems.check(
            (1..=MAX_UNIQUE_KEY_CHARS).contains(&len),
            "unique_key",
            "must be 1 to 200 characters",
        );
    }
    problems.finish()?;

    let run_at = match (body.run_at, body.delay_seconds) {
        (Some(at), _) => at.max(now),
        (None, Some(delay)) => now + Duration::seconds(delay),
        (None, None) => now,
    };
    Ok(NewJob {
        queue: body.queue,
        kind: body.kind,
        payload: body.payload,
        priority: body.priority.unwrap_or(5),
        run_at,
        max_attempts: body.max_attempts,
        lease_seconds: body.lease_seconds,
        unique_key: body.unique_key,
        schedule_id: None,
        scheduled_for: None,
        created_by_token_id: Some(caller.token_id),
    })
}

/// `POST /api/jobs`: enqueues a job. Returns `201` for a new job and `200` when the live job
/// holding the same unique key is returned.
pub async fn enqueue(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiJson(body): ApiJson<EnqueueBody>,
) -> Result<(StatusCode, Json<EnqueueResponse>), ApiError> {
    ensure(&caller, Action::Enqueue)?;
    let now = state.clock.now();
    let new = new_job_from(body, &caller, now)?;
    ensure_usable(&caller, &new.queue)?;
    let enqueued = jobs::enqueue(&state.pool, &new, now).await?;
    let status = if enqueued.deduplicated {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((
        status,
        Json(EnqueueResponse {
            job: enqueued.job,
            deduplicated: enqueued.deduplicated,
        }),
    ))
}

/// Prefixes the field paths of a validation error with `prefix`.
fn nested(err: ApiError, prefix: &str) -> ApiError {
    match err {
        ApiError::Validation(fields) => ApiError::Validation(
            fields
                .into_iter()
                .map(|f| FieldError::new(format!("{prefix}.{}", f.path), f.message))
                .collect(),
        ),
        other => other,
    }
}

/// `POST /api/jobs/batch`: enqueues up to 100 jobs in one transaction. Returns `201` when at
/// least one job was created and `200` when every job was deduplicated.
pub async fn enqueue_batch(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiJson(body): ApiJson<BatchBody>,
) -> Result<(StatusCode, Json<BatchResponse>), ApiError> {
    ensure(&caller, Action::Enqueue)?;
    if body.jobs.is_empty() || body.jobs.len() > jobs::MAX_BATCH {
        return Err(ApiError::field("jobs", "must hold 1 to 100 jobs"));
    }
    let now = state.clock.now();
    let mut batch = Vec::with_capacity(body.jobs.len());
    for (i, item) in body.jobs.into_iter().enumerate() {
        match new_job_from(item, &caller, now) {
            Ok(new) => batch.push(new),
            Err(err) => return Err(nested(err, &format!("jobs[{i}]"))),
        }
    }
    let enqueued = jobs::enqueue_batch(&state.pool, &batch, now).await?;
    let created = enqueued.iter().filter(|e| !e.deduplicated).count();
    tracing::info!(jobs = batch.len(), created, "batch enqueued");
    let status = if created > 0 {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    let items = enqueued
        .into_iter()
        .map(|e| EnqueueResponse {
            job: e.job,
            deduplicated: e.deduplicated,
        })
        .collect();
    Ok((status, Json(BatchResponse { items })))
}

/// Loads a job the caller may see.
pub(crate) async fn visible_job(
    state: &AppState,
    caller: &Caller,
    id: Uuid,
) -> Result<Job, ApiError> {
    let job = jobs::get_job(&state.pool, id).await?;
    ensure_visible(caller, &job.queue)?;
    Ok(job)
}

/// `GET /api/jobs/{id}`: shows a job with its attempts.
pub async fn show(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(id): ApiPath<Uuid>,
) -> Result<Json<JobDetail>, ApiError> {
    ensure(&caller, Action::Read)?;
    let job = visible_job(&state, &caller, id).await?;
    let attempts = jobs::list_attempts(&state.pool, id).await?;
    Ok(Json(JobDetail { job, attempts }))
}

/// `GET /api/jobs`: lists jobs newest first, filtered by queue, state and kind.
pub async fn list(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiQuery(query): ApiQuery<ListJobsQuery>,
) -> Result<Json<Page<Job>>, ApiError> {
    ensure(&caller, Action::Read)?;
    let limit = page_limit(query.limit)?;
    let after = time_cursor(query.after.as_deref())?;
    if let Some(state_name) = &query.state {
        state_name
            .parse::<JobState>()
            .map_err(|_| ApiError::field("state", "is not a job state"))?;
    }
    let filter = JobFilter {
        queue: query.queue,
        state: query.state,
        kind: query.kind,
        within_queues: caller.queue_scope().map(|q| q.to_vec()),
    };
    let rows = jobs::list_jobs(&state.pool, &filter, after, limit + 1).await?;
    Ok(Json(Page::from_rows(rows, limit, |job| {
        TimeCursor {
            created_at: job.created_at,
            id: job.id,
        }
        .encode()
    })))
}

/// `POST /api/jobs/{id}/cancel`: cancels a pending job (`200`) or asks a running job to stop
/// (`202`).
pub async fn cancel(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(id): ApiPath<Uuid>,
) -> Result<(StatusCode, Json<Job>), ApiError> {
    ensure(&caller, Action::Cancel)?;
    visible_job(&state, &caller, id).await?;
    let cancellation = jobs::cancel_job(&state.pool, id, state.clock.now()).await?;
    let status = if cancellation.immediate {
        StatusCode::OK
    } else {
        StatusCode::ACCEPTED
    };
    tracing::info!(job_id = %id, immediate = cancellation.immediate, "job cancellation");
    Ok((status, Json(cancellation.job)))
}

/// `POST /api/jobs/{id}/requeue`: puts a dead job back on its queue.
pub async fn requeue(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(id): ApiPath<Uuid>,
) -> Result<Json<Job>, ApiError> {
    ensure(&caller, Action::Recover)?;
    visible_job(&state, &caller, id).await?;
    let job = jobs::requeue_job(&state.pool, id, state.clock.now()).await?;
    tracing::info!(job_id = %id, "dead job requeued");
    Ok(Json(job))
}
