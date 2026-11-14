#![allow(dead_code)]

pub mod fake;

use std::sync::Arc;

use chrono::{DateTime, TimeZone, Utc};
use engine_core::clock::{FixedClock, FixedJitter};
use engine_store::claim::{claim, ClaimedJob};
use engine_store::jobs::{enqueue, NewJob};
use engine_store::queues::{create_queue, NewQueue};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;
use wfe_worker::handlers::{builtin_registry, Registry};
use wfe_worker::runner::RunnerEnv;
use wfe_worker::store::PgWorkerStore;

pub const QUEUE: &str = "work";

pub fn t0() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 1, 5, 12, 0, 0).unwrap()
}

pub async fn make_queue(pool: &PgPool) {
    let spec = NewQueue {
        name: QUEUE.to_string(),
        max_concurrency: None,
        rate_limit: None,
        default_max_attempts: 3,
        default_lease_seconds: 60,
        backoff_base_ms: 1000,
        backoff_cap_ms: 3_600_000,
    };
    create_queue(pool, &spec, t0()).await.unwrap();
}

pub fn registry() -> Registry {
    builtin_registry(reqwest::Client::new())
}

pub fn db_env(pool: &PgPool, clock: Arc<FixedClock>, registry: Registry) -> Arc<RunnerEnv> {
    Arc::new(RunnerEnv {
        store: Arc::new(PgWorkerStore::new(pool.clone(), Arc::new(FixedJitter(0.5)))),
        clock,
        registry,
        worker_id: "test-worker".to_string(),
    })
}

pub async fn add_job(pool: &PgPool, kind: &str, payload: Value) -> Uuid {
    let new = NewJob::new(QUEUE, kind, payload, t0());
    enqueue(pool, &new, t0()).await.unwrap().job.id
}

pub async fn claim_next(pool: &PgPool, kinds: &[String], at: DateTime<Utc>) -> ClaimedJob {
    let mut jobs = claim(pool, QUEUE, kinds, "test-worker", 1, at).await.unwrap();
    assert_eq!(jobs.len(), 1, "expected a claimable job");
    jobs.remove(0)
}

pub async fn job_row(pool: &PgPool, id: Uuid) -> engine_store::models::Job {
    engine_store::jobs::get_job(pool, id).await.unwrap()
}
