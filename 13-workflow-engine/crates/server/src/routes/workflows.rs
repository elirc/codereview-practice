use axum::extract::State;
use axum::http::StatusCode;
use axum::{Extension, Json};
use engine_core::authz::{Action, Caller};
use engine_core::dag::StepDef;
use engine_core::limits::{json_size, MAX_PAYLOAD_BYTES};
use engine_core::names::is_queue_name;
use engine_core::state::RunState;
use engine_store::page::{Page, TimeCursor};
use engine_store::workflows::{self, RunDetail, WorkflowDefinition, WorkflowRun};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::auth::ensure;
use crate::error::ApiError;
use crate::extract::{ApiJson, ApiPath, ApiQuery};
use crate::pagination::{page_limit, time_cursor};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateDefinitionBody {
    name: String,
    steps: Vec<StepDef>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartRunBody {
    name: String,
    version: Option<i32>,
    input: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListRunsQuery {
    state: Option<String>,
    after: Option<String>,
    limit: Option<i64>,
}

/// `POST /api/workflow-definitions`: stores a new version of a workflow definition.
pub async fn create_definition(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiJson(body): ApiJson<CreateDefinitionBody>,
) -> Result<(StatusCode, Json<WorkflowDefinition>), ApiError> {
    ensure(&caller, Action::Configure)?;
    if !is_queue_name(&body.name) {
        return Err(ApiError::field("name", "must match [a-z0-9_-]{1,64}"));
    }
    let now = state.clock.now();
    let definition = workflows::create_definition(&state.pool, &body.name, &body.steps, now).await?;
    tracing::info!(
        definition = %definition.name,
        version = definition.version,
        "workflow definition stored"
    );
    Ok((StatusCode::CREATED, Json(definition)))
}

/// `GET /api/workflow-definitions/{name}`: lists every version of a definition.
pub async fn show_definition(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(name): ApiPath<String>,
) -> Result<Json<Vec<WorkflowDefinition>>, ApiError> {
    ensure(&caller, Action::ReadConfiguration)?;
    let versions = workflows::list_definition_versions(&state.pool, &name).await?;
    if versions.is_empty() {
        return Err(ApiError::NotFound);
    }
    Ok(Json(versions))
}

/// `POST /api/workflow-runs`: starts a run of the latest (or the given) definition version.
pub async fn start_run(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiJson(body): ApiJson<StartRunBody>,
) -> Result<(StatusCode, Json<RunDetail>), ApiError> {
    ensure(&caller, Action::StartRun)?;
    if json_size(&body.input) > MAX_PAYLOAD_BYTES {
        return Err(ApiError::PayloadTooLarge("input".to_string()));
    }
    let definition = workflows::find_definition(&state.pool, &body.name, body.version).await?;
    if !caller.may_use_all(definition.queues.iter().map(String::as_str)) {
        return Err(ApiError::Forbidden);
    }
    let detail = workflows::start_run(
        &state.pool,
        &definition,
        &body.input,
        Some(caller.token_id),
        state.clock.now(),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(detail)))
}

/// Loads a run the caller may see.
pub(crate) async fn visible_run(
    state: &AppState,
    caller: &Caller,
    id: Uuid,
) -> Result<RunDetail, ApiError> {
    let detail = workflows::get_run_detail(&state.pool, id).await?;
    if !caller.may_use_all(detail.run.queues.iter().map(String::as_str)) {
        return Err(ApiError::NotFound);
    }
    Ok(detail)
}

/// `GET /api/workflow-runs/{id}`: shows a run with its steps.
pub async fn show_run(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(id): ApiPath<Uuid>,
) -> Result<Json<RunDetail>, ApiError> {
    ensure(&caller, Action::Read)?;
    Ok(Json(visible_run(&state, &caller, id).await?))
}

/// `GET /api/workflow-runs`: lists runs newest first.
pub async fn list_runs(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiQuery(query): ApiQuery<ListRunsQuery>,
) -> Result<Json<Page<WorkflowRun>>, ApiError> {
    ensure(&caller, Action::Read)?;
    let limit = page_limit(query.limit)?;
    let after = time_cursor(query.after.as_deref())?;
    if let Some(s) = &query.state {
        s.parse::<RunState>()
            .map_err(|_| ApiError::field("state", "is not a run state"))?;
    }
    let rows = workflows::list_runs(
        &state.pool,
        query.state.as_deref(),
        caller.queue_scope(),
        after,
        limit + 1,
    )
    .await?;
    Ok(Json(Page::from_rows(rows, limit, |run| {
        TimeCursor {
            created_at: run.created_at,
            id: run.id,
        }
        .encode()
    })))
}
