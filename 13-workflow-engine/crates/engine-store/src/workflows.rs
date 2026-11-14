//! Workflow definitions, starting runs and reading them back.

use std::collections::{BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Utc};
use engine_core::dag::{roots, step_payload, validate_definition, StepDef};
use engine_core::state::StepState;
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::error::is_unique_violation;
use crate::page::TimeCursor;
use crate::queues::existing_queue_names;
use crate::StoreError;

/// One immutable version of a workflow definition.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct WorkflowDefinition {
    pub id: Uuid,
    pub name: String,
    pub version: i32,
    pub steps: Value,
    pub queues: Vec<String>,
    pub created_at: DateTime<Utc>,
}

impl WorkflowDefinition {
    /// Returns the parsed steps.
    pub fn step_defs(&self) -> Result<Vec<StepDef>, StoreError> {
        serde_json::from_value(self.steps.clone()).map_err(|e| {
            StoreError::Corrupt(format!("definition {} has invalid steps: {e}", self.id))
        })
    }
}

const DEFINITION_COLUMNS: &str = "id, name, version, steps, queues, created_at";

/// A workflow run with the name, version and queues of its definition.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct WorkflowRun {
    pub id: Uuid,
    pub definition_id: Uuid,
    pub definition_name: String,
    pub definition_version: i32,
    pub queues: Vec<String>,
    pub state: String,
    pub input: Value,
    pub cancel_requested: bool,
    pub created_by_token_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

pub(crate) const RUN_SELECT: &str = "SELECT r.id, r.definition_id, d.name AS definition_name, \
     d.version AS definition_version, d.queues, r.state, r.input, r.cancel_requested, \
     r.created_by_token_id, r.created_at, r.finished_at \
     FROM workflow_runs r JOIN workflow_definitions d ON d.id = r.definition_id";

/// The state of one step in a run.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct WorkflowStep {
    pub run_id: Uuid,
    pub step_key: String,
    pub state: String,
    pub job_id: Option<Uuid>,
    pub output: Option<Value>,
}

/// A run with its steps.
#[derive(Debug, Clone, Serialize)]
pub struct RunDetail {
    #[serde(flatten)]
    pub run: WorkflowRun,
    pub steps: Vec<WorkflowStep>,
}

/// Stores a new version of the definition `name` and returns it. Versions start at 1.
pub async fn create_definition(
    pool: &PgPool,
    name: &str,
    steps: &[StepDef],
    now: DateTime<Utc>,
) -> Result<WorkflowDefinition, StoreError> {
    let mut conn = pool.acquire().await?;
    let wanted: Vec<String> = steps.iter().map(|s| s.queue.clone()).collect();
    let known: HashSet<String> = existing_queue_names(&mut conn, &wanted)
        .await?
        .into_iter()
        .collect();
    let problems = validate_definition(steps, &known);
    if !problems.is_empty() {
        return Err(StoreError::InvalidWorkflow(problems));
    }
    let queues: Vec<String> = wanted
        .into_iter()
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let steps_json = serde_json::to_value(steps)
        .map_err(|e| StoreError::Corrupt(format!("could not encode steps: {e}")))?;

    let sql = format!(
        "INSERT INTO workflow_definitions (id, name, version, steps, queues, created_at) \
         SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4, $5 \
         FROM workflow_definitions WHERE name = $2 \
         RETURNING {DEFINITION_COLUMNS}"
    );
    let mut last_err = None;
    for _ in 0..5 {
        let result = sqlx::query_as::<_, WorkflowDefinition>(&sql)
            .bind(Uuid::new_v4())
            .bind(name)
            .bind(&steps_json)
            .bind(&queues)
            .bind(now)
            .fetch_one(&mut *conn)
            .await;
        match result {
            Ok(definition) => return Ok(definition),
            Err(err) if is_unique_violation(&err, "workflow_definitions_name_version_key") => {
                last_err = Some(err);
            }
            Err(err) => return Err(err.into()),
        }
    }
    Err(last_err
        .map(StoreError::from)
        .unwrap_or_else(|| StoreError::Corrupt("definition insert retried".to_string())))
}

/// Lists every version of the definition `name`, oldest first.
pub async fn list_definition_versions(
    pool: &PgPool,
    name: &str,
) -> Result<Vec<WorkflowDefinition>, StoreError> {
    let sql = format!(
        "SELECT {DEFINITION_COLUMNS} FROM workflow_definitions WHERE name = $1 ORDER BY version"
    );
    let definitions = sqlx::query_as::<_, WorkflowDefinition>(&sql)
        .bind(name)
        .fetch_all(pool)
        .await?;
    Ok(definitions)
}

/// Loads a version of the definition `name`, or its latest version.
pub async fn find_definition(
    pool: &PgPool,
    name: &str,
    version: Option<i32>,
) -> Result<WorkflowDefinition, StoreError> {
    let sql = format!(
        "SELECT {DEFINITION_COLUMNS} FROM workflow_definitions \
         WHERE name = $1 AND ($2::int IS NULL OR version = $2) \
         ORDER BY version DESC LIMIT 1"
    );
    sqlx::query_as::<_, WorkflowDefinition>(&sql)
        .bind(name)
        .bind(version)
        .fetch_optional(pool)
        .await?
        .ok_or(StoreError::NotFound)
}

/// Starts a run of `definition` with `input`: steps without dependencies get a job at once,
/// the rest wait. Returns the run with its steps.
pub async fn start_run(
    pool: &PgPool,
    definition: &WorkflowDefinition,
    input: &Value,
    created_by_token_id: Option<Uuid>,
    now: DateTime<Utc>,
) -> Result<RunDetail, StoreError> {
    let steps = definition.step_defs()?;
    let run_id = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO workflow_runs (id, definition_id, state, input, created_by_token_id, \
         created_at) VALUES ($1, $2, 'running', $3, $4, $5)",
    )
    .bind(run_id)
    .bind(definition.id)
    .bind(input)
    .bind(created_by_token_id)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    for step in &steps {
        sqlx::query(
            "INSERT INTO workflow_steps (run_id, step_key, state) VALUES ($1, $2, 'blocked')",
        )
        .bind(run_id)
        .bind(&step.key)
        .execute(&mut *tx)
        .await?;
    }
    let no_outputs = HashMap::new();
    for step in roots(&steps) {
        let payload = step_payload(step, input, &no_outputs);
        let job_id = insert_step_job(&mut tx, run_id, step, &payload, now).await?;
        mark_step_queued(&mut tx, run_id, &step.key, job_id).await?;
    }
    tx.commit().await?;
    tracing::info!(run_id = %run_id, definition = %definition.name, "workflow run started");
    get_run_detail(pool, run_id).await
}

/// Creates the job of a workflow step and returns its id.
pub(crate) async fn insert_step_job(
    conn: &mut PgConnection,
    run_id: Uuid,
    step: &StepDef,
    payload: &Value,
    now: DateTime<Utc>,
) -> Result<Uuid, StoreError> {
    let defaults = sqlx::query_as::<_, (i32, i32)>(
        "SELECT default_max_attempts, default_lease_seconds FROM queues WHERE name = $1",
    )
    .bind(&step.queue)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| StoreError::UnknownQueue(step.queue.clone()))?;
    let id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO jobs (id, queue, kind, payload, priority, state, run_at, max_attempts, \
         lease_seconds, workflow_run_id, step_key, created_at) \
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $6) RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind(&step.queue)
    .bind(&step.kind)
    .bind(payload)
    .bind(step.priority.unwrap_or(5))
    .bind(now)
    .bind(step.max_attempts.unwrap_or(defaults.0))
    .bind(step.lease_seconds.unwrap_or(defaults.1))
    .bind(run_id)
    .bind(&step.key)
    .fetch_one(&mut *conn)
    .await?;
    Ok(id)
}

pub(crate) async fn mark_step_queued(
    conn: &mut PgConnection,
    run_id: Uuid,
    step_key: &str,
    job_id: Uuid,
) -> Result<(), StoreError> {
    sqlx::query(
        "UPDATE workflow_steps SET state = $3, job_id = $4 WHERE run_id = $1 AND step_key = $2",
    )
    .bind(run_id)
    .bind(step_key)
    .bind(StepState::Queued.as_str())
    .bind(job_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Loads a run with its steps.
pub async fn get_run_detail(pool: &PgPool, id: Uuid) -> Result<RunDetail, StoreError> {
    let sql = format!("{RUN_SELECT} WHERE r.id = $1");
    let run = sqlx::query_as::<_, WorkflowRun>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(StoreError::NotFound)?;
    let steps = sqlx::query_as::<_, WorkflowStep>(
        "SELECT s.run_id, s.step_key, s.state, s.job_id, s.output \
         FROM workflow_steps s WHERE s.run_id = $1 ORDER BY s.step_key",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    Ok(RunDetail { run, steps })
}

/// Lists runs newest first, optionally by state and limited to runs whose queues are all in
/// `within_queues`.
pub async fn list_runs(
    pool: &PgPool,
    state: Option<&str>,
    within_queues: Option<&[String]>,
    after: Option<TimeCursor>,
    limit: i64,
) -> Result<Vec<WorkflowRun>, StoreError> {
    let sql = format!(
        "{RUN_SELECT} \
         WHERE ($1::text IS NULL OR r.state = $1) \
           AND ($2::text[] IS NULL OR d.queues <@ $2) \
           AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3, $4)) \
         ORDER BY r.created_at DESC, r.id DESC LIMIT $5"
    );
    let runs = sqlx::query_as::<_, WorkflowRun>(&sql)
        .bind(state)
        .bind(within_queues.map(|q| q.to_vec()))
        .bind(after.map(|c| c.created_at))
        .bind(after.map(|c| c.id))
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(runs)
}
