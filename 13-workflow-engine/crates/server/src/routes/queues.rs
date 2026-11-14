use axum::extract::State;
use axum::http::StatusCode;
use axum::{Extension, Json};
use engine_core::authz::{Action, Caller};
use engine_core::names::is_queue_name;
use engine_store::models::Queue;
use engine_store::page::Page;
use engine_store::queues::{self, NewQueue, QueuePatch, RateLimit};
use serde::Deserialize;

use crate::auth::{ensure, ensure_visible};
use crate::error::ApiError;
use crate::extract::{ApiJson, ApiPath, ApiQuery};
use crate::pagination::page_limit;
use crate::state::AppState;
use crate::validate::{double_option, Problems};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQueuesQuery {
    after: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateQueueBody {
    name: String,
    max_concurrency: Option<i32>,
    rate_limit_per_minute: Option<i32>,
    rate_burst: Option<i32>,
    default_max_attempts: Option<i32>,
    default_lease_seconds: Option<i32>,
    backoff_base_ms: Option<i64>,
    backoff_cap_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchQueueBody {
    #[serde(default, deserialize_with = "double_option")]
    max_concurrency: Option<Option<i32>>,
    #[serde(default, deserialize_with = "double_option")]
    rate_limit_per_minute: Option<Option<i32>>,
    #[serde(default, deserialize_with = "double_option")]
    rate_burst: Option<Option<i32>>,
    default_max_attempts: Option<i32>,
    default_lease_seconds: Option<i32>,
    backoff_base_ms: Option<i64>,
    backoff_cap_ms: Option<i64>,
}

fn check_limits(
    problems: &mut Problems,
    max_attempts: Option<i32>,
    lease_seconds: Option<i32>,
    base_ms: Option<i64>,
    cap_ms: Option<i64>,
) {
    problems.range(max_attempts, 1, 50, "default_max_attempts");
    problems.range(lease_seconds, 5, 3600, "default_lease_seconds");
    problems.range(base_ms, 1, i64::MAX, "backoff_base_ms");
    problems.range(cap_ms, 1, i64::MAX, "backoff_cap_ms");
}

fn rate_limit_of(
    problems: &mut Problems,
    per_minute: Option<i32>,
    burst: Option<i32>,
) -> Option<RateLimit> {
    problems.range(per_minute, 1, i32::MAX, "rate_limit_per_minute");
    problems.range(burst, 1, i32::MAX, "rate_burst");
    match (per_minute, burst) {
        (Some(per_minute), Some(burst)) => Some(RateLimit { per_minute, burst }),
        (None, None) => None,
        _ => {
            problems.check(
                false,
                "rate_burst",
                "rate_limit_per_minute and rate_burst must be given together",
            );
            None
        }
    }
}

/// `GET /api/queues`: lists the queues the caller may use.
pub async fn list(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiQuery(query): ApiQuery<ListQueuesQuery>,
) -> Result<Json<Page<Queue>>, ApiError> {
    ensure(&caller, Action::Read)?;
    let limit = page_limit(query.limit)?;
    let rows = queues::list_queues(
        &state.pool,
        query.after.as_deref(),
        limit + 1,
        caller.queue_scope(),
    )
    .await?;
    Ok(Json(Page::from_rows(rows, limit, |q| q.name.clone())))
}

/// `POST /api/queues`: creates a queue.
pub async fn create(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiJson(body): ApiJson<CreateQueueBody>,
) -> Result<(StatusCode, Json<Queue>), ApiError> {
    ensure(&caller, Action::Configure)?;
    let mut problems = Problems::new();
    problems.check(
        is_queue_name(&body.name),
        "name",
        "must match [a-z0-9_-]{1,64}",
    );
    problems.range(body.max_concurrency, 1, i32::MAX, "max_concurrency");
    check_limits(
        &mut problems,
        body.default_max_attempts,
        body.default_lease_seconds,
        body.backoff_base_ms,
        body.backoff_cap_ms,
    );
    let rate_limit = rate_limit_of(&mut problems, body.rate_limit_per_minute, body.rate_burst);
    let new = NewQueue {
        name: body.name,
        max_concurrency: body.max_concurrency,
        rate_limit,
        default_max_attempts: body.default_max_attempts.unwrap_or(5),
        default_lease_seconds: body.default_lease_seconds.unwrap_or(60),
        backoff_base_ms: body.backoff_base_ms.unwrap_or(1000),
        backoff_cap_ms: body.backoff_cap_ms.unwrap_or(3_600_000),
    };
    problems.check(
        new.backoff_cap_ms >= new.backoff_base_ms,
        "backoff_cap_ms",
        "must be at least backoff_base_ms",
    );
    problems.finish()?;
    let queue = queues::create_queue(&state.pool, &new, state.clock.now()).await?;
    Ok((StatusCode::CREATED, Json(queue)))
}

/// `GET /api/queues/{name}`: shows one queue.
pub async fn show(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(name): ApiPath<String>,
) -> Result<Json<Queue>, ApiError> {
    ensure(&caller, Action::Read)?;
    ensure_visible(&caller, &name)?;
    Ok(Json(queues::get_queue(&state.pool, &name).await?))
}

/// `PATCH /api/queues/{name}`: changes a queue's limits.
pub async fn update(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(name): ApiPath<String>,
    ApiJson(body): ApiJson<PatchQueueBody>,
) -> Result<Json<Queue>, ApiError> {
    ensure(&caller, Action::Configure)?;
    let mut problems = Problems::new();
    problems.range(body.max_concurrency.flatten(), 1, i32::MAX, "max_concurrency");
    check_limits(
        &mut problems,
        body.default_max_attempts,
        body.default_lease_seconds,
        body.backoff_base_ms,
        body.backoff_cap_ms,
    );
    let rate_limit = match (body.rate_limit_per_minute, body.rate_burst) {
        (None, None) => None,
        (Some(per_minute), Some(burst)) => Some(rate_limit_of(&mut problems, per_minute, burst)),
        _ => {
            problems.check(
                false,
                "rate_burst",
                "rate_limit_per_minute and rate_burst must be given together",
            );
            None
        }
    };
    problems.finish()?;
    let patch = QueuePatch {
        max_concurrency: body.max_concurrency,
        rate_limit,
        default_max_attempts: body.default_max_attempts,
        default_lease_seconds: body.default_lease_seconds,
        backoff_base_ms: body.backoff_base_ms,
        backoff_cap_ms: body.backoff_cap_ms,
    };
    let queue = queues::update_queue(&state.pool, &name, &patch, state.clock.now()).await?;
    Ok(Json(queue))
}

/// `POST /api/queues/{name}/pause`: stops claims from a queue.
pub async fn pause(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(name): ApiPath<String>,
) -> Result<Json<Queue>, ApiError> {
    ensure(&caller, Action::Control)?;
    Ok(Json(queues::set_queue_paused(&state.pool, &name, true).await?))
}

/// `POST /api/queues/{name}/resume`: re-enables claims from a queue.
pub async fn resume(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(name): ApiPath<String>,
) -> Result<Json<Queue>, ApiError> {
    ensure(&caller, Action::Control)?;
    Ok(Json(queues::set_queue_paused(&state.pool, &name, false).await?))
}
