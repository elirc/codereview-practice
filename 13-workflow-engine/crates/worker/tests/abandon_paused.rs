mod common;

use std::sync::Arc;
use std::time::Duration;

use common::fake::{claimed, fake_env, FakeStore};
use common::registry;
use engine_core::state::JobState;
use serde_json::json;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use wfe_worker::runner::{run_claimed, run_job, ClaimContext, RunOutcome};

#[tokio::test(start_paused = true)]
async fn failing_heartbeats_stop_the_handler_before_the_lease_ends() {
    let store = Arc::new(FakeStore::default());
    store.state().heartbeat_fails = true;
    let env = fake_env(store.clone(), registry());
    let job = claimed("sleep", json!({ "ms": 600_000 }), 6);
    let cancel = CancellationToken::new();

    let started = Instant::now();
    let outcome = run_job(env, job, cancel.clone()).await;
    assert_eq!(outcome, RunOutcome::Abandoned);
    assert_eq!(started.elapsed(), Duration::from_secs(4));
    assert!(cancel.is_cancelled());

    let state = store.state();
    assert!(state.completed.is_empty());
    assert!(state.failed.is_empty());
    assert!(state.released.is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_successful_heartbeat_restarts_the_allowance() {
    let store = Arc::new(FakeStore::default());
    store.state().fail_next_heartbeats = 1;
    let env = fake_env(store.clone(), registry());
    let job = claimed("sleep", json!({ "ms": 8_000 }), 9);

    let outcome = run_job(env, job.clone(), CancellationToken::new()).await;
    assert_eq!(outcome, RunOutcome::Reported(JobState::Succeeded));
    let state = store.state();
    assert_eq!(state.heartbeats, 1);
    assert_eq!(state.completed.len(), 1);
    assert_eq!(state.completed[0].0, job.id);
}

#[tokio::test(start_paused = true)]
async fn lost_claim_stops_the_handler_and_reports_nothing() {
    let store = Arc::new(FakeStore::default());
    store.state().lease_lost = true;
    let env = fake_env(store.clone(), registry());
    let job = claimed("sleep", json!({ "ms": 600_000 }), 30);

    let started = Instant::now();
    let outcome = run_job(env, job, CancellationToken::new()).await;
    assert_eq!(outcome, RunOutcome::Abandoned);
    assert_eq!(started.elapsed(), Duration::from_secs(10));
    let state = store.state();
    assert!(state.completed.is_empty());
    assert!(state.failed.is_empty());
}

#[tokio::test(start_paused = true)]
async fn report_failures_are_retried_until_the_claim_would_expire() {
    let store = Arc::new(FakeStore::default());
    store.state().report_fails = true;
    let env = fake_env(store.clone(), registry());
    let job = claimed("noop", json!({}), 6);

    let started = Instant::now();
    let outcome = run_job(env, job, CancellationToken::new()).await;
    assert_eq!(outcome, RunOutcome::NotReported);
    assert!(started.elapsed() <= Duration::from_secs(4));
    assert!(started.elapsed() >= Duration::from_secs(2));
    assert!(store.state().completed.is_empty());
}

#[tokio::test(start_paused = true)]
async fn time_spent_claiming_counts_against_the_lease() {
    let store = Arc::new(FakeStore::default());
    store.state().heartbeat_fails = true;
    let env = fake_env(store.clone(), registry());
    let job = claimed("sleep", json!({ "ms": 600_000 }), 6);
    let claim_ctx = ClaimContext {
        claimed_at: Instant::now(),
        worker_stop: CancellationToken::new(),
    };
    tokio::time::advance(Duration::from_secs(3)).await;

    let started = Instant::now();
    let outcome = run_claimed(env, job, CancellationToken::new(), claim_ctx).await;
    assert_eq!(outcome, RunOutcome::Abandoned);
    assert_eq!(started.elapsed(), Duration::from_secs(1));
    assert!(store.state().failed.is_empty());
}
