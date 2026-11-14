mod common;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use common::fake::{claimed, fake_env, FakeStore};
use common::registry;
use serde_json::{json, Value};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use wfe_worker::handlers::{Handler, HandlerError, JobContext, Registry};
use wfe_worker::worker::{Worker, WorkerSettings};

fn settings() -> WorkerSettings {
    WorkerSettings {
        queues: vec!["work".to_string()],
        concurrency: 4,
        poll_interval: Duration::from_millis(500),
        shutdown_grace: Duration::from_secs(30),
    }
}

/// Starts a worker on `store` and returns once it has claimed everything pending.
async fn start(
    store: Arc<FakeStore>,
    registry: Registry,
) -> (tokio::task::JoinHandle<()>, CancellationToken) {
    let env = fake_env(store.clone(), registry);
    let stop = CancellationToken::new();
    let handle = tokio::spawn(Worker::new(env, settings()).run(stop.clone()));
    while !store.state().pending.is_empty() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    (handle, stop)
}

#[tokio::test(start_paused = true)]
async fn a_job_that_finishes_within_the_grace_period_is_reported() {
    let store = Arc::new(FakeStore::default());
    let job = claimed("sleep", json!({ "ms": 2_000 }), 60);
    store.push(job.clone());
    let (handle, stop) = start(store.clone(), registry()).await;

    let stopping = Instant::now();
    stop.cancel();
    handle.await.unwrap();
    assert!(stopping.elapsed() <= Duration::from_secs(2));

    let state = store.state();
    assert_eq!(state.completed.len(), 1);
    assert_eq!(state.completed[0].0, job.id);
    assert!(state.released.is_empty());
}

#[tokio::test(start_paused = true)]
async fn no_new_claims_after_shutdown_starts() {
    let store = Arc::new(FakeStore::default());
    store.push(claimed("sleep", json!({ "ms": 2_000 }), 60));
    let (handle, stop) = start(store.clone(), registry()).await;
    stop.cancel();
    let late = claimed("noop", json!({}), 60);
    store.push(late.clone());
    handle.await.unwrap();

    let state = store.state();
    assert_eq!(state.pending.len(), 1);
    assert!(state.completed.iter().all(|(id, _)| *id != late.id));
}

#[tokio::test(start_paused = true)]
async fn a_job_that_stops_when_cancelled_is_released() {
    let store = Arc::new(FakeStore::default());
    let job = claimed("sleep", json!({ "ms": 600_000 }), 60);
    store.push(job.clone());
    let (handle, stop) = start(store.clone(), registry()).await;

    let stopping = Instant::now();
    stop.cancel();
    handle.await.unwrap();
    assert_eq!(stopping.elapsed(), Duration::from_secs(30));

    let state = store.state();
    assert_eq!(state.released, vec![job.id]);
    assert!(state.failed.is_empty());
    assert!(state.completed.is_empty());
}

struct Deaf;

#[async_trait]
impl Handler for Deaf {
    async fn run(&self, _ctx: JobContext) -> Result<Value, HandlerError> {
        tokio::time::sleep(Duration::from_secs(10_000)).await;
        Ok(json!("too late"))
    }
}

#[tokio::test(start_paused = true)]
async fn a_job_that_outlives_the_grace_period_is_released() {
    let store = Arc::new(FakeStore::default());
    let mut registry = registry();
    registry.register("deaf", Arc::new(Deaf));
    let job = claimed("deaf", json!({}), 60);
    store.push(job.clone());
    let (handle, stop) = start(store.clone(), registry).await;

    let stopping = Instant::now();
    stop.cancel();
    handle.await.unwrap();
    assert_eq!(stopping.elapsed(), Duration::from_secs(35));

    let state = store.state();
    assert_eq!(state.released, vec![job.id]);
    assert!(state.completed.is_empty());
    assert!(state.failed.is_empty());
}
