//! Row types returned by the store. Field names match the JSON the API returns.

use chrono::{DateTime, Utc};
use engine_core::state::JobState;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::StoreError;

/// A named queue and its limits.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct Queue {
    pub name: String,
    pub paused: bool,
    pub max_concurrency: Option<i32>,
    pub rate_limit_per_minute: Option<i32>,
    pub rate_burst: Option<i32>,
    pub rate_tokens_milli: i64,
    pub rate_refilled_at: DateTime<Utc>,
    pub default_max_attempts: i32,
    pub default_lease_seconds: i32,
    pub backoff_base_ms: i64,
    pub backoff_cap_ms: i64,
    pub created_at: DateTime<Utc>,
}

pub(crate) const QUEUE_COLUMNS: &str = "name, paused, max_concurrency, rate_limit_per_minute, \
     rate_burst, rate_tokens_milli, rate_refilled_at, default_max_attempts, \
     default_lease_seconds, backoff_base_ms, backoff_cap_ms, created_at";

/// A job and its current lease, if any.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct Job {
    pub id: Uuid,
    pub queue: String,
    pub kind: String,
    pub payload: Value,
    pub priority: i32,
    pub state: String,
    pub run_at: DateTime<Utc>,
    pub attempt: i32,
    pub max_attempts: i32,
    pub lease_seconds: i32,
    pub lease_epoch: i64,
    pub lease_owner: Option<String>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub heartbeat_at: Option<DateTime<Utc>>,
    pub cancel_requested: bool,
    pub unique_key: Option<String>,
    pub result: Option<Value>,
    pub last_error: Option<String>,
    pub dead_reason: Option<String>,
    pub schedule_id: Option<Uuid>,
    pub scheduled_for: Option<DateTime<Utc>>,
    pub workflow_run_id: Option<Uuid>,
    pub step_key: Option<String>,
    pub created_by_token_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

impl Job {
    /// Returns the parsed job state.
    pub fn job_state(&self) -> Result<JobState, StoreError> {
        self.state
            .parse()
            .map_err(|_| StoreError::Corrupt(format!("job {} has state {}", self.id, self.state)))
    }
}

pub(crate) const JOB_COLUMNS: &str = "id, queue, kind, payload, priority, state, run_at, attempt, \
     max_attempts, lease_seconds, lease_epoch, lease_owner, lease_expires_at, heartbeat_at, \
     cancel_requested, unique_key, result, last_error, dead_reason, schedule_id, scheduled_for, \
     workflow_run_id, step_key, created_by_token_id, created_at, started_at, finished_at";

/// One claim of a job by a worker.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct JobAttempt {
    pub job_id: Uuid,
    pub attempt: i32,
    pub lease_epoch: i64,
    pub worker_id: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub outcome: Option<String>,
    pub error: Option<String>,
}

/// An API token without its secret.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct ApiToken {
    pub id: Uuid,
    pub name: String,
    pub role: String,
    pub queues: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

pub(crate) const TOKEN_COLUMNS: &str = "id, name, role, queues, created_at, revoked_at";
