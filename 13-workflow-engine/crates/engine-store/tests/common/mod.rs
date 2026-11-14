#![allow(dead_code)]

use chrono::{DateTime, Duration, TimeZone, Utc};
use engine_store::jobs::{enqueue, NewJob};
use engine_store::models::{Job, Queue};
use engine_store::queues::{create_queue, NewQueue};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

pub const WORKER_A: &str = "worker-a";
pub const WORKER_B: &str = "worker-b";

/// The instant every database test starts at.
pub fn t0() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 1, 5, 12, 0, 0).unwrap()
}

pub fn secs(n: i64) -> Duration {
    Duration::seconds(n)
}

pub fn queue_spec(name: &str) -> NewQueue {
    NewQueue {
        name: name.to_string(),
        max_concurrency: None,
        rate_limit: None,
        default_max_attempts: 5,
        default_lease_seconds: 60,
        backoff_base_ms: 1000,
        backoff_cap_ms: 3_600_000,
    }
}

pub async fn make_queue(pool: &PgPool, name: &str) -> Queue {
    create_queue(pool, &queue_spec(name), t0()).await.unwrap()
}

pub async fn make_queue_with(pool: &PgPool, spec: NewQueue) -> Queue {
    create_queue(pool, &spec, t0()).await.unwrap()
}

pub fn kinds(list: &[&str]) -> Vec<String> {
    list.iter().map(|k| k.to_string()).collect()
}

pub async fn add_job(pool: &PgPool, queue: &str, kind: &str, run_at: DateTime<Utc>) -> Job {
    let new = NewJob::new(queue, kind, json!({}), run_at);
    enqueue(pool, &new, t0()).await.unwrap().job
}

pub async fn add_job_with(pool: &PgPool, new: NewJob, now: DateTime<Utc>) -> Job {
    enqueue(pool, &new, now).await.unwrap().job
}

pub async fn job_state(pool: &PgPool, id: Uuid) -> String {
    sqlx::query_scalar::<_, String>("SELECT state FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

pub async fn running_count(pool: &PgPool, queue: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM jobs WHERE queue = $1 AND state = 'running'",
    )
    .bind(queue)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Marks a pending job as succeeded directly in the database.
pub async fn force_succeeded(pool: &PgPool, id: Uuid, at: DateTime<Utc>) {
    sqlx::query(
        "UPDATE jobs SET state = 'succeeded', finished_at = $2, lease_owner = NULL, \
         lease_expires_at = NULL WHERE id = $1",
    )
    .bind(id)
    .bind(at)
    .execute(pool)
    .await
    .unwrap();
}
