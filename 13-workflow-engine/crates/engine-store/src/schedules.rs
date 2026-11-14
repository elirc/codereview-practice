//! Cron schedules and the scheduler pass that turns due fire times into jobs.

use chrono::{DateTime, Utc};
use engine_core::cron_plan::{
    next_fire_after, parse_cron, plan_fires, schedule_unique_key, CatchupPolicy,
};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::error::{is_foreign_key_violation, is_unique_violation};
use crate::jobs::{enqueue_on, NewJob};
use crate::StoreError;

/// Largest number of schedules handled in one scheduler pass.
pub const SCHEDULER_BATCH: usize = 20;

/// A cron schedule that creates jobs.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct Schedule {
    pub id: Uuid,
    pub name: String,
    pub cron_expr: String,
    pub queue: String,
    pub kind: String,
    pub payload: Value,
    pub priority: i32,
    pub catchup: String,
    pub max_catchup: i32,
    pub paused: bool,
    pub next_fire_at: DateTime<Utc>,
    pub last_fire_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

const SCHEDULE_COLUMNS: &str = "id, name, cron_expr, queue, kind, payload, priority, catchup, \
     max_catchup, paused, next_fire_at, last_fire_at, created_at";

/// Fields of a schedule to create.
#[derive(Debug, Clone)]
pub struct NewSchedule {
    pub name: String,
    pub cron_expr: String,
    pub queue: String,
    pub kind: String,
    pub payload: Value,
    pub priority: i32,
    pub catchup: CatchupPolicy,
    pub max_catchup: i32,
    pub paused: bool,
}

/// Changes to a schedule; `None` leaves a field unchanged.
#[derive(Debug, Clone, Default)]
pub struct SchedulePatch {
    pub name: Option<String>,
    pub cron_expr: Option<String>,
    pub queue: Option<String>,
    pub kind: Option<String>,
    pub payload: Option<Value>,
    pub priority: Option<i32>,
    pub catchup: Option<CatchupPolicy>,
    pub max_catchup: Option<i32>,
}

fn first_fire_after(cron_expr: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>, StoreError> {
    let parsed = parse_cron(cron_expr).map_err(StoreError::InvalidCron)?;
    next_fire_after(&parsed, now)
        .ok_or_else(|| StoreError::InvalidCron("the expression never fires again".to_string()))
}

fn map_write_error(err: sqlx::Error, queue: &str) -> StoreError {
    if is_unique_violation(&err, "schedules_name_key") {
        StoreError::InvalidState("A schedule with this name already exists.".to_string())
    } else if is_foreign_key_violation(&err, "schedules_queue_fkey") {
        StoreError::UnknownQueue(queue.to_string())
    } else {
        err.into()
    }
}

/// Creates a schedule whose first fire time is the first one strictly after `now`.
pub async fn create_schedule(
    pool: &PgPool,
    new: &NewSchedule,
    now: DateTime<Utc>,
) -> Result<Schedule, StoreError> {
    let next_fire_at = first_fire_after(&new.cron_expr, now)?;
    let sql = format!(
        "INSERT INTO schedules (id, name, cron_expr, queue, kind, payload, priority, catchup, \
         max_catchup, paused, next_fire_at, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) \
         RETURNING {SCHEDULE_COLUMNS}"
    );
    sqlx::query_as::<_, Schedule>(&sql)
        .bind(Uuid::new_v4())
        .bind(&new.name)
        .bind(new.cron_expr.trim())
        .bind(&new.queue)
        .bind(&new.kind)
        .bind(&new.payload)
        .bind(new.priority)
        .bind(new.catchup.as_str())
        .bind(new.max_catchup)
        .bind(new.paused)
        .bind(next_fire_at)
        .bind(now)
        .fetch_one(pool)
        .await
        .map_err(|e| map_write_error(e, &new.queue))
}

/// Loads a schedule by id.
pub async fn get_schedule(pool: &PgPool, id: Uuid) -> Result<Schedule, StoreError> {
    let sql = format!("SELECT {SCHEDULE_COLUMNS} FROM schedules WHERE id = $1");
    sqlx::query_as::<_, Schedule>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(StoreError::NotFound)
}

/// Lists schedules ordered by name, starting after the name `after`.
pub async fn list_schedules(
    pool: &PgPool,
    after: Option<&str>,
    limit: i64,
) -> Result<Vec<Schedule>, StoreError> {
    let sql = format!(
        "SELECT {SCHEDULE_COLUMNS} FROM schedules WHERE ($1::text IS NULL OR name > $1) \
         ORDER BY name LIMIT $2"
    );
    let schedules = sqlx::query_as::<_, Schedule>(&sql)
        .bind(after)
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(schedules)
}

/// Applies `patch` to a schedule. A new cron expression recomputes the next fire time from
/// `now`.
pub async fn update_schedule(
    pool: &PgPool,
    id: Uuid,
    patch: &SchedulePatch,
    now: DateTime<Utc>,
) -> Result<Schedule, StoreError> {
    let mut tx = pool.begin().await?;
    let sql = format!("SELECT {SCHEDULE_COLUMNS} FROM schedules WHERE id = $1 FOR UPDATE");
    let mut s = sqlx::query_as::<_, Schedule>(&sql)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::NotFound)?;
    if let Some(expr) = &patch.cron_expr {
        s.next_fire_at = first_fire_after(expr, now)?;
        s.cron_expr = expr.trim().to_string();
    }
    if let Some(name) = &patch.name {
        s.name = name.clone();
    }
    if let Some(queue) = &patch.queue {
        s.queue = queue.clone();
    }
    if let Some(kind) = &patch.kind {
        s.kind = kind.clone();
    }
    if let Some(payload) = &patch.payload {
        s.payload = payload.clone();
    }
    if let Some(priority) = patch.priority {
        s.priority = priority;
    }
    if let Some(catchup) = patch.catchup {
        s.catchup = catchup.as_str().to_string();
    }
    if let Some(max_catchup) = patch.max_catchup {
        s.max_catchup = max_catchup;
    }
    let sql = format!(
        "UPDATE schedules SET name = $2, cron_expr = $3, queue = $4, kind = $5, payload = $6, \
         priority = $7, catchup = $8, max_catchup = $9, next_fire_at = $10 \
         WHERE id = $1 RETURNING {SCHEDULE_COLUMNS}"
    );
    let updated = sqlx::query_as::<_, Schedule>(&sql)
        .bind(id)
        .bind(&s.name)
        .bind(&s.cron_expr)
        .bind(&s.queue)
        .bind(&s.kind)
        .bind(&s.payload)
        .bind(s.priority)
        .bind(&s.catchup)
        .bind(s.max_catchup)
        .bind(s.next_fire_at)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| map_write_error(e, &s.queue))?;
    tx.commit().await?;
    Ok(updated)
}

/// Deletes a schedule. Jobs it created are kept.
pub async fn delete_schedule(pool: &PgPool, id: Uuid) -> Result<(), StoreError> {
    let result = sqlx::query("DELETE FROM schedules WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// Pauses a schedule.
pub async fn pause_schedule(pool: &PgPool, id: Uuid) -> Result<Schedule, StoreError> {
    let sql =
        format!("UPDATE schedules SET paused = true WHERE id = $1 RETURNING {SCHEDULE_COLUMNS}");
    sqlx::query_as::<_, Schedule>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(StoreError::NotFound)
}

/// Resumes a paused schedule from the first fire time strictly after `now`. Resuming a
/// schedule that is not paused changes nothing.
pub async fn resume_schedule(
    pool: &PgPool,
    id: Uuid,
    now: DateTime<Utc>,
) -> Result<Schedule, StoreError> {
    let mut tx = pool.begin().await?;
    let sql = format!("SELECT {SCHEDULE_COLUMNS} FROM schedules WHERE id = $1 FOR UPDATE");
    let s = sqlx::query_as::<_, Schedule>(&sql)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::NotFound)?;
    if !s.paused {
        return Ok(s);
    }
    let next_fire_at = first_fire_after(&s.cron_expr, now)?;
    let sql = format!(
        "UPDATE schedules SET paused = false, next_fire_at = $2 WHERE id = $1 \
         RETURNING {SCHEDULE_COLUMNS}"
    );
    let resumed = sqlx::query_as::<_, Schedule>(&sql)
        .bind(id)
        .bind(next_fire_at)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(resumed)
}

/// Runs one scheduler pass: each due, unpaused schedule (up to [`SCHEDULER_BATCH`]) is handled
/// in its own transaction. Returns the number of jobs created.
pub async fn run_scheduler_once(pool: &PgPool, now: DateTime<Utc>) -> Result<usize, StoreError> {
    let mut created = 0;
    let mut failed: Vec<Uuid> = Vec::new();
    let sql = format!(
        "SELECT {SCHEDULE_COLUMNS} FROM schedules \
         WHERE NOT paused AND next_fire_at <= $1 AND NOT (id = ANY($2)) \
         ORDER BY next_fire_at, id LIMIT 1 \
         FOR UPDATE SKIP LOCKED"
    );
    for _ in 0..SCHEDULER_BATCH {
        let mut tx = pool.begin().await?;
        let due = sqlx::query_as::<_, Schedule>(&sql)
            .bind(now)
            .bind(&failed)
            .fetch_optional(&mut *tx)
            .await?;
        let Some(schedule) = due else {
            break;
        };
        match fire(&mut tx, &schedule, now).await {
            Ok(count) => {
                tx.commit().await?;
                created += count;
            }
            Err(err) => {
                tx.rollback().await?;
                tracing::error!(
                    schedule_id = %schedule.id,
                    error = %err,
                    "schedule pass failed; retrying on the next pass"
                );
                failed.push(schedule.id);
            }
        }
    }
    Ok(created)
}

async fn fire(
    conn: &mut PgConnection,
    schedule: &Schedule,
    now: DateTime<Utc>,
) -> Result<usize, StoreError> {
    let parsed = match parse_cron(&schedule.cron_expr) {
        Ok(parsed) => parsed,
        Err(reason) => {
            sqlx::query("UPDATE schedules SET paused = true WHERE id = $1")
                .bind(schedule.id)
                .execute(&mut *conn)
                .await?;
            tracing::error!(
                schedule_id = %schedule.id,
                reason = %reason,
                "stored cron expression is invalid; schedule paused"
            );
            return Ok(0);
        }
    };
    let policy: CatchupPolicy = schedule.catchup.parse().map_err(|_| {
        StoreError::Corrupt(format!("schedule {} has catch-up {}", schedule.id, schedule.catchup))
    })?;
    let plan = plan_fires(
        &parsed,
        policy,
        schedule.max_catchup,
        schedule.next_fire_at,
        now,
        schedule.id,
    );

    for planned in &plan.fires {
        let mut job = NewJob::new(
            &schedule.queue,
            &schedule.kind,
            schedule.payload.clone(),
            planned.run_at,
        );
        job.priority = schedule.priority;
        job.unique_key = Some(schedule_unique_key(schedule.id, planned.scheduled_for));
        job.schedule_id = Some(schedule.id);
        job.scheduled_for = Some(planned.scheduled_for);
        enqueue_on(conn, &job, now).await?;
    }

    match plan.next_fire_at {
        Some(next) => {
            sqlx::query(
                "UPDATE schedules SET next_fire_at = $2, last_fire_at = COALESCE($3, last_fire_at) \
                 WHERE id = $1",
            )
            .bind(schedule.id)
            .bind(next)
            .bind(plan.last_fire_at)
            .execute(&mut *conn)
            .await?;
        }
        None => {
            sqlx::query(
                "UPDATE schedules SET paused = true, last_fire_at = COALESCE($2, last_fire_at) \
                 WHERE id = $1",
            )
            .bind(schedule.id)
            .bind(plan.last_fire_at)
            .execute(&mut *conn)
            .await?;
            tracing::warn!(schedule_id = %schedule.id, "schedule never fires again; paused");
        }
    }
    if !plan.fires.is_empty() {
        tracing::info!(
            schedule_id = %schedule.id,
            jobs = plan.fires.len(),
            "schedule fired"
        );
    }
    Ok(plan.fires.len())
}
