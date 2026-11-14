//! Moving workflow runs forward when their step jobs end, and cancelling or retrying runs.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use engine_core::dag::{ready_steps, step_payload, StepDef};
use engine_core::resolve::resolve_run;
use engine_core::state::{JobState, RunState, StepState};
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::jobs::reset_to_pending;
use crate::workflows::{get_run_detail, insert_step_job, mark_step_queued, RunDetail};
use crate::StoreError;

/// How a step's job ended.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum JobEnd {
    Succeeded(Value),
    Dead,
    Cancelled,
}

impl JobEnd {
    /// Returns the end for a terminal failure state, or `None` for a retry.
    pub(crate) fn from_failure(state: JobState) -> Option<Self> {
        match state {
            JobState::Dead => Some(Self::Dead),
            JobState::Cancelled => Some(Self::Cancelled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct LockedRun {
    pub state: String,
    pub cancel_requested: bool,
    pub input: Value,
    pub steps: Value,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct StepRow {
    step_key: String,
    state: String,
    job_id: Option<Uuid>,
    output: Option<Value>,
}

/// Locks a run's row for the rest of the transaction and returns it with its definition's
/// steps, or `None` if the run does not exist.
pub(crate) async fn lock_run(
    conn: &mut PgConnection,
    run_id: Uuid,
) -> Result<Option<LockedRun>, StoreError> {
    let run = sqlx::query_as::<_, LockedRun>(
        "SELECT r.state, r.cancel_requested, r.input, d.steps \
         FROM workflow_runs r JOIN workflow_definitions d ON d.id = r.definition_id \
         WHERE r.id = $1 FOR UPDATE OF r",
    )
    .bind(run_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(run)
}

fn parse_steps(run_id: Uuid, steps: &Value) -> Result<Vec<StepDef>, StoreError> {
    serde_json::from_value(steps.clone())
        .map_err(|e| StoreError::Corrupt(format!("run {run_id} has invalid steps: {e}")))
}

fn parse_step_state(raw: &str) -> Result<StepState, StoreError> {
    raw.parse()
        .map_err(|_| StoreError::Corrupt(format!("unknown step state {raw}")))
}

async fn load_steps(conn: &mut PgConnection, run_id: Uuid) -> Result<Vec<StepRow>, StoreError> {
    let rows = sqlx::query_as::<_, StepRow>(
        "SELECT step_key, state, job_id, output FROM workflow_steps WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows)
}

async fn set_step_state(
    conn: &mut PgConnection,
    run_id: Uuid,
    step_key: &str,
    state: StepState,
) -> Result<(), StoreError> {
    sqlx::query("UPDATE workflow_steps SET state = $3 WHERE run_id = $1 AND step_key = $2")
        .bind(run_id)
        .bind(step_key)
        .bind(state.as_str())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Records the end of a step's job and moves the run forward. The run must already be
/// locked by the caller's transaction.
pub(crate) async fn on_step_job_ended(
    conn: &mut PgConnection,
    run_id: Uuid,
    step_key: &str,
    job_id: Uuid,
    end: JobEnd,
    now: DateTime<Utc>,
) -> Result<(), StoreError> {
    let Some(run) = lock_run(conn, run_id).await? else {
        return Ok(());
    };
    let recorded = match &end {
        JobEnd::Succeeded(output) => sqlx::query(
            "UPDATE workflow_steps SET state = 'succeeded', output = $4 \
             WHERE run_id = $1 AND step_key = $2 AND job_id = $3",
        )
        .bind(run_id)
        .bind(step_key)
        .bind(job_id)
        .bind(output)
        .execute(&mut *conn)
        .await?
        .rows_affected(),
        JobEnd::Dead | JobEnd::Cancelled => {
            let state = if end == JobEnd::Dead {
                StepState::Failed
            } else {
                StepState::Cancelled
            };
            sqlx::query(
                "UPDATE workflow_steps SET state = $4 \
                 WHERE run_id = $1 AND step_key = $2 AND job_id = $3",
            )
            .bind(run_id)
            .bind(step_key)
            .bind(job_id)
            .bind(state.as_str())
            .execute(&mut *conn)
            .await?
            .rows_affected()
        }
    };
    if recorded == 0 {
        return Err(StoreError::Corrupt(format!(
            "job {job_id} is not the job of step {step_key} in run {run_id}"
        )));
    }

    let running = run.state == RunState::Running.as_str();
    match end {
        JobEnd::Succeeded(_) if running && !run.cancel_requested => {
            queue_ready_steps(conn, run_id, &run, now).await?;
        }
        JobEnd::Dead => {
            sqlx::query(
                "UPDATE workflow_steps SET state = 'skipped' \
                 WHERE run_id = $1 AND state = 'blocked'",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            stop_queued_steps(conn, run_id, Some(step_key), now).await?;
        }
        _ => {}
    }
    resolve(conn, run_id, now).await
}

/// Gives every `blocked` step whose dependencies have all succeeded a job.
async fn queue_ready_steps(
    conn: &mut PgConnection,
    run_id: Uuid,
    run: &LockedRun,
    now: DateTime<Utc>,
) -> Result<usize, StoreError> {
    let steps = parse_steps(run_id, &run.steps)?;
    let rows = load_steps(conn, run_id).await?;
    let mut states: HashMap<String, StepState> = HashMap::new();
    let mut outputs: HashMap<String, Value> = HashMap::new();
    for row in rows {
        states.insert(row.step_key.clone(), parse_step_state(&row.state)?);
        if let Some(output) = row.output {
            outputs.insert(row.step_key, output);
        }
    }
    let ready = ready_steps(&steps, &states);
    for step in &ready {
        let payload = step_payload(step, &run.input, &outputs);
        let job_id = insert_step_job(conn, run_id, step, &payload, now).await?;
        mark_step_queued(conn, run_id, &step.key, job_id).await?;
        tracing::info!(run_id = %run_id, step_key = %step.key, job_id = %job_id, "step queued");
    }
    Ok(ready.len())
}

/// Stops the jobs of `queued` steps other than `except`: pending jobs are cancelled with their
/// step, running jobs are asked to stop.
async fn stop_queued_steps(
    conn: &mut PgConnection,
    run_id: Uuid,
    except: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), StoreError> {
    let rows = load_steps(conn, run_id).await?;
    for row in rows {
        if row.state != StepState::Queued.as_str() || Some(row.step_key.as_str()) == except {
            continue;
        }
        let Some(job_id) = row.job_id else {
            continue;
        };
        let cancelled = sqlx::query_scalar::<_, Uuid>(
            "UPDATE jobs SET state = 'cancelled', finished_at = $2 \
             WHERE id = $1 AND state = 'pending' RETURNING id",
        )
        .bind(job_id)
        .bind(now)
        .fetch_optional(&mut *conn)
        .await?;
        if cancelled.is_some() {
            set_step_state(conn, run_id, &row.step_key, StepState::Cancelled).await?;
        } else {
            sqlx::query(
                "UPDATE jobs SET cancel_requested = true WHERE id = $1 AND state = 'running'",
            )
            .bind(job_id)
            .execute(&mut *conn)
            .await?;
        }
    }
    Ok(())
}

/// Moves a running run to its final state once none of its steps is queued.
async fn resolve(
    conn: &mut PgConnection,
    run_id: Uuid,
    now: DateTime<Utc>,
) -> Result<(), StoreError> {
    let (state, cancel_requested) = sqlx::query_as::<_, (String, bool)>(
        "SELECT state, cancel_requested FROM workflow_runs WHERE id = $1",
    )
    .bind(run_id)
    .fetch_one(&mut *conn)
    .await?;
    if state != RunState::Running.as_str() {
        return Ok(());
    }
    let mut step_states = Vec::new();
    for row in load_steps(conn, run_id).await? {
        step_states.push(parse_step_state(&row.state)?);
    }
    if let Some(final_state) = resolve_run(cancel_requested, &step_states) {
        sqlx::query("UPDATE workflow_runs SET state = $2, finished_at = $3 WHERE id = $1")
            .bind(run_id)
            .bind(final_state.as_str())
            .bind(now)
            .execute(&mut *conn)
            .await?;
        tracing::info!(run_id = %run_id, state = final_state.as_str(), "workflow run finished");
    }
    Ok(())
}

/// Cancels a running run: waiting steps are cancelled, pending jobs are cancelled and running
/// jobs are asked to stop. The run ends `cancelled` once no step is queued.
pub async fn cancel_run(
    pool: &PgPool,
    run_id: Uuid,
    now: DateTime<Utc>,
) -> Result<RunDetail, StoreError> {
    let mut tx = pool.begin().await?;
    let run = lock_run(&mut tx, run_id)
        .await?
        .ok_or(StoreError::NotFound)?;
    if run.state != RunState::Running.as_str() {
        return Err(StoreError::InvalidState(
            "Only running workflow runs can be cancelled.".to_string(),
        ));
    }
    sqlx::query("UPDATE workflow_runs SET cancel_requested = true WHERE id = $1")
        .bind(run_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE workflow_steps SET state = 'cancelled' WHERE run_id = $1 AND state = 'blocked'",
    )
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    stop_queued_steps(&mut tx, run_id, None, now).await?;
    resolve(&mut tx, run_id, now).await?;
    tx.commit().await?;
    tracing::info!(run_id = %run_id, "workflow run cancellation requested");
    get_run_detail(pool, run_id).await
}

/// Retries a failed run: failed and cancelled steps get their job back, skipped steps wait
/// again, and succeeded steps keep their outputs.
pub async fn retry_run(
    pool: &PgPool,
    run_id: Uuid,
    now: DateTime<Utc>,
) -> Result<RunDetail, StoreError> {
    let mut tx = pool.begin().await?;
    let run = lock_run(&mut tx, run_id)
        .await?
        .ok_or(StoreError::NotFound)?;
    if run.state != RunState::Failed.as_str() {
        return Err(StoreError::InvalidState(
            "Only failed workflow runs can be retried.".to_string(),
        ));
    }
    for row in load_steps(&mut tx, run_id).await? {
        match parse_step_state(&row.state)? {
            StepState::Failed | StepState::Cancelled => match row.job_id {
                Some(job_id) => {
                    reset_to_pending(&mut tx, job_id, now).await?;
                    set_step_state(&mut tx, run_id, &row.step_key, StepState::Queued).await?;
                }
                None => {
                    set_step_state(&mut tx, run_id, &row.step_key, StepState::Blocked).await?;
                }
            },
            StepState::Skipped => {
                set_step_state(&mut tx, run_id, &row.step_key, StepState::Blocked).await?;
            }
            StepState::Blocked | StepState::Queued | StepState::Succeeded => {}
        }
    }
    sqlx::query(
        "UPDATE workflow_runs SET state = 'running', finished_at = NULL, \
         cancel_requested = false WHERE id = $1",
    )
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    queue_ready_steps(&mut tx, run_id, &run, now).await?;
    tx.commit().await?;
    tracing::info!(run_id = %run_id, "workflow run retried");
    get_run_detail(pool, run_id).await
}
