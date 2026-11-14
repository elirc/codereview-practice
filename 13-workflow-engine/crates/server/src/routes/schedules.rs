use axum::extract::State;
use axum::http::StatusCode;
use axum::{Extension, Json};
use engine_core::authz::{Action, Caller};
use engine_core::cron_plan::CatchupPolicy;
use engine_core::limits::{json_size, MAX_PAYLOAD_BYTES};
use engine_core::names::{is_kind, is_queue_name};
use engine_store::page::Page;
use engine_store::schedules::{self, NewSchedule, Schedule, SchedulePatch};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::ensure;
use crate::error::ApiError;
use crate::extract::{ApiJson, ApiPath, ApiQuery};
use crate::pagination::page_limit;
use crate::state::AppState;
use crate::validate::Problems;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListSchedulesQuery {
    after: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateScheduleBody {
    name: String,
    cron_expr: String,
    queue: String,
    kind: String,
    payload: Option<Value>,
    priority: Option<i32>,
    catchup: Option<CatchupPolicy>,
    max_catchup: Option<i32>,
    paused: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchScheduleBody {
    name: Option<String>,
    cron_expr: Option<String>,
    queue: Option<String>,
    kind: Option<String>,
    payload: Option<Value>,
    priority: Option<i32>,
    catchup: Option<CatchupPolicy>,
    max_catchup: Option<i32>,
}

struct Fields<'a> {
    name: Option<&'a str>,
    queue: Option<&'a str>,
    kind: Option<&'a str>,
    payload: Option<&'a Value>,
    priority: Option<i32>,
    max_catchup: Option<i32>,
}

fn validate(fields: Fields<'_>) -> Result<(), ApiError> {
    if fields.payload.is_some_and(|p| json_size(p) > MAX_PAYLOAD_BYTES) {
        return Err(ApiError::PayloadTooLarge("payload".to_string()));
    }
    let mut problems = Problems::new();
    if let Some(name) = fields.name {
        let len = name.trim().chars().count();
        problems.check((1..=100).contains(&len), "name", "must be 1 to 100 characters");
    }
    if let Some(queue) = fields.queue {
        problems.check(is_queue_name(queue), "queue", "must match [a-z0-9_-]{1,64}");
    }
    if let Some(kind) = fields.kind {
        problems.check(is_kind(kind), "kind", "must match [a-z0-9_.]{1,64}");
    }
    problems.range(fields.priority, 0, 9, "priority");
    problems.range(fields.max_catchup, 1, 100, "max_catchup");
    problems.finish()
}

/// `GET /api/schedules`: lists schedules by name.
pub async fn list(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiQuery(query): ApiQuery<ListSchedulesQuery>,
) -> Result<Json<Page<Schedule>>, ApiError> {
    ensure(&caller, Action::ReadConfiguration)?;
    let limit = page_limit(query.limit)?;
    let rows = schedules::list_schedules(&state.pool, query.after.as_deref(), limit + 1).await?;
    Ok(Json(Page::from_rows(rows, limit, |s| s.name.clone())))
}

/// `POST /api/schedules`: creates a schedule.
pub async fn create(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiJson(body): ApiJson<CreateScheduleBody>,
) -> Result<(StatusCode, Json<Schedule>), ApiError> {
    ensure(&caller, Action::Configure)?;
    validate(Fields {
        name: Some(&body.name),
        queue: Some(&body.queue),
        kind: Some(&body.kind),
        payload: body.payload.as_ref(),
        priority: body.priority,
        max_catchup: body.max_catchup,
    })?;
    let new = NewSchedule {
        name: body.name.trim().to_string(),
        cron_expr: body.cron_expr,
        queue: body.queue,
        kind: body.kind,
        payload: body.payload.unwrap_or_else(|| json!({})),
        priority: body.priority.unwrap_or(5),
        catchup: body.catchup.unwrap_or(CatchupPolicy::Skip),
        max_catchup: body.max_catchup.unwrap_or(10),
        paused: body.paused.unwrap_or(false),
    };
    let schedule = schedules::create_schedule(&state.pool, &new, state.clock.now()).await?;
    tracing::info!(schedule_id = %schedule.id, "schedule created");
    Ok((StatusCode::CREATED, Json(schedule)))
}

/// `GET /api/schedules/{id}`: shows one schedule.
pub async fn show(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(id): ApiPath<Uuid>,
) -> Result<Json<Schedule>, ApiError> {
    ensure(&caller, Action::ReadConfiguration)?;
    Ok(Json(schedules::get_schedule(&state.pool, id).await?))
}

/// `PATCH /api/schedules/{id}`: edits a schedule.
pub async fn update(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<PatchScheduleBody>,
) -> Result<Json<Schedule>, ApiError> {
    ensure(&caller, Action::Configure)?;
    validate(Fields {
        name: body.name.as_deref(),
        queue: body.queue.as_deref(),
        kind: body.kind.as_deref(),
        payload: body.payload.as_ref(),
        priority: body.priority,
        max_catchup: body.max_catchup,
    })?;
    let patch = SchedulePatch {
        name: body.name.map(|n| n.trim().to_string()),
        cron_expr: body.cron_expr,
        queue: body.queue,
        kind: body.kind,
        payload: body.payload,
        priority: body.priority,
        catchup: body.catchup,
        max_catchup: body.max_catchup,
    };
    let schedule = schedules::update_schedule(&state.pool, id, &patch, state.clock.now()).await?;
    Ok(Json(schedule))
}

/// `DELETE /api/schedules/{id}`: deletes a schedule and keeps its jobs.
pub async fn remove(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(id): ApiPath<Uuid>,
) -> Result<StatusCode, ApiError> {
    ensure(&caller, Action::Configure)?;
    schedules::delete_schedule(&state.pool, id).await?;
    tracing::info!(schedule_id = %id, "schedule deleted");
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/schedules/{id}/pause`: stops a schedule from firing.
pub async fn pause(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(id): ApiPath<Uuid>,
) -> Result<Json<Schedule>, ApiError> {
    ensure(&caller, Action::Control)?;
    Ok(Json(schedules::pause_schedule(&state.pool, id).await?))
}

/// `POST /api/schedules/{id}/resume`: resumes a schedule from its next fire time after now.
pub async fn resume(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(id): ApiPath<Uuid>,
) -> Result<Json<Schedule>, ApiError> {
    ensure(&caller, Action::Control)?;
    let schedule = schedules::resume_schedule(&state.pool, id, state.clock.now()).await?;
    Ok(Json(schedule))
}
