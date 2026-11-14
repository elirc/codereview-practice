mod common;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use common::fake::{claimed, fake_env, FakeStore};
use common::registry;
use engine_core::outcome::FailureKind;
use engine_core::state::JobState;
use serde_json::{json, Value};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use wfe_worker::handlers::{Handler, HandlerError, JobContext};
use wfe_worker::runner::{run_job, RunOutcome};

#[tokio::test(start_paused = true)]
async fn cancellation_reaches_the_handler_at_the_next_heartbeat() {
    let store = Arc::new(FakeStore::default());
    store.state().cancel_requested = true;
    let env = fake_env(store.clone(), registry());
    let job = claimed("sleep", json!({ "ms": 600_000 }), 30);

    let started = Instant::now();
    let outcome = run_job(env, job.clone(), CancellationToken::new()).await;
    assert_eq!(outcome, RunOutcome::Reported(JobState::Cancelled));
    assert_eq!(started.elapsed(), Duration::from_secs(10));

    let state = store.state();
    assert_eq!(state.heartbeats, 1);
    assert_eq!(
        state.failed,
        vec![(job.id, FailureKind::Cancelled, "cancelled".to_string())]
    );
}

struct Stubborn;

#[async_trait]
impl Handler for Stubborn {
    async fn run(&self, _ctx: JobContext) -> Result<Value, HandlerError> {
        tokio::time::sleep(Duration::from_secs(25)).await;
        Ok(json!("done anyway"))
    }
}

#[tokio::test(start_paused = true)]
async fn handler_that_ignores_cancellation_still_succeeds() {
    let store = Arc::new(FakeStore::default());
    store.state().cancel_requested = true;
    let mut registry = registry();
    registry.register("stubborn", Arc::new(Stubborn));
    let env = fake_env(store.clone(), registry);
    let job = claimed("stubborn", json!({}), 30);

    let outcome = run_job(env, job.clone(), CancellationToken::new()).await;
    assert_eq!(outcome, RunOutcome::Reported(JobState::Succeeded));
    let state = store.state();
    assert_eq!(state.completed, vec![(job.id, json!("done anyway"))]);
    assert!(state.heartbeats >= 2);
}
