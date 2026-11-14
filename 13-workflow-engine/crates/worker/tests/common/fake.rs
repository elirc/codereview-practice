use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use engine_core::clock::FixedClock;
use engine_core::outcome::FailureKind;
use engine_core::state::JobState;
use engine_store::claim::{ClaimRef, ClaimedJob};
use engine_store::lease::Completion;
use engine_store::StoreError;
use serde_json::Value;
use uuid::Uuid;
use wfe_worker::handlers::Registry;
use wfe_worker::runner::RunnerEnv;
use wfe_worker::store::WorkerStore;

use super::t0;

/// What the fake store has been asked to do, and how it should answer.
#[derive(Debug, Default)]
pub struct FakeState {
    pub pending: Vec<ClaimedJob>,
    pub cancel_requested: bool,
    pub heartbeat_fails: bool,
    pub fail_next_heartbeats: usize,
    pub lease_lost: bool,
    pub report_fails: bool,
    pub heartbeats: usize,
    pub completed: Vec<(Uuid, Value)>,
    pub failed: Vec<(Uuid, FailureKind, String)>,
    pub released: Vec<Uuid>,
}

/// In-memory [`WorkerStore`] for tests that control time.
#[derive(Debug, Default)]
pub struct FakeStore {
    state: Mutex<FakeState>,
}

impl FakeStore {
    pub fn state(&self) -> MutexGuard<'_, FakeState> {
        self.state.lock().unwrap()
    }

    pub fn push(&self, job: ClaimedJob) {
        self.state().pending.push(job);
    }
}

fn db_down() -> StoreError {
    StoreError::Db(sqlx::Error::PoolTimedOut)
}

#[async_trait]
impl WorkerStore for FakeStore {
    async fn claim(
        &self,
        _queue: &str,
        _kinds: &[String],
        _worker_id: &str,
        limit: i64,
        _now: DateTime<Utc>,
    ) -> Result<Vec<ClaimedJob>, StoreError> {
        let mut state = self.state();
        let take = usize::try_from(limit).unwrap().min(state.pending.len());
        Ok(state.pending.drain(..take).collect())
    }

    async fn heartbeat(&self, _claim: &ClaimRef, _now: DateTime<Utc>) -> Result<bool, StoreError> {
        let mut state = self.state();
        if state.heartbeat_fails {
            return Err(db_down());
        }
        if state.fail_next_heartbeats > 0 {
            state.fail_next_heartbeats -= 1;
            return Err(db_down());
        }
        if state.lease_lost {
            return Err(StoreError::LeaseLost);
        }
        state.heartbeats += 1;
        Ok(state.cancel_requested)
    }

    async fn complete(
        &self,
        claim: &ClaimRef,
        result: &Value,
        _now: DateTime<Utc>,
    ) -> Result<Completion, StoreError> {
        let mut state = self.state();
        if state.report_fails {
            return Err(db_down());
        }
        state.completed.push((claim.job_id, result.clone()));
        Ok(Completion::Succeeded)
    }

    async fn fail(
        &self,
        claim: &ClaimRef,
        kind: FailureKind,
        message: &str,
        _now: DateTime<Utc>,
    ) -> Result<JobState, StoreError> {
        let mut state = self.state();
        if state.report_fails {
            return Err(db_down());
        }
        state.failed.push((claim.job_id, kind, message.to_string()));
        let next = match kind {
            FailureKind::Permanent => JobState::Dead,
            FailureKind::Cancelled if state.cancel_requested => JobState::Cancelled,
            _ if state.cancel_requested => JobState::Cancelled,
            _ => JobState::Pending,
        };
        Ok(next)
    }

    async fn release(&self, claim: &ClaimRef, _now: DateTime<Utc>) -> Result<JobState, StoreError> {
        let mut state = self.state();
        if state.report_fails {
            return Err(db_down());
        }
        state.released.push(claim.job_id);
        Ok(JobState::Pending)
    }
}

/// Builds a claimed job of `kind` with a lease of `lease_seconds`.
pub fn claimed(kind: &str, payload: Value, lease_seconds: i32) -> ClaimedJob {
    ClaimedJob {
        id: Uuid::new_v4(),
        queue: "work".to_string(),
        kind: kind.to_string(),
        payload,
        priority: 5,
        run_at: t0(),
        attempt: 1,
        max_attempts: 3,
        lease_seconds,
        lease_epoch: 1,
        lease_expires_at: t0(),
        workflow_run_id: None,
        step_key: None,
    }
}

/// Runner environment around a fake store.
pub fn fake_env(store: Arc<FakeStore>, registry: Registry) -> Arc<RunnerEnv> {
    Arc::new(RunnerEnv {
        store,
        clock: Arc::new(FixedClock::new(t0())),
        registry,
        worker_id: "fake-worker".to_string(),
        lease_safety_ms: 2000,
    })
}
