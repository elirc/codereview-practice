mod common;

use common::*;
use engine_store::jobs::{enqueue, get_job, NewJob};
use engine_store::queues::{update_queue, QueuePatch};
use engine_store::StoreError;
use serde_json::json;
use sqlx::PgPool;

fn keyed(queue: &str, key: &str, payload: serde_json::Value) -> NewJob {
    let mut new = NewJob::new(queue, "email.send", payload, t0());
    new.unique_key = Some(key.to_string());
    new
}

#[sqlx::test(migrations = "../../migrations")]
async fn limits_default_from_the_queue_and_stay_fixed(pool: PgPool) {
    let mut spec = queue_spec("email");
    spec.default_max_attempts = 3;
    spec.default_lease_seconds = 30;
    make_queue_with(&pool, spec).await;

    let job = add_job(&pool, "email", "email.send", t0()).await;
    assert_eq!(job.max_attempts, 3);
    assert_eq!(job.lease_seconds, 30);
    assert_eq!(job.state, "pending");
    assert_eq!(job.priority, 5);

    let patch = QueuePatch {
        default_max_attempts: Some(10),
        default_lease_seconds: Some(120),
        ..QueuePatch::default()
    };
    update_queue(&pool, "email", &patch, t0()).await.unwrap();
    let reloaded = get_job(&pool, job.id).await.unwrap();
    assert_eq!(reloaded.max_attempts, 3);
    assert_eq!(reloaded.lease_seconds, 30);
}

#[sqlx::test(migrations = "../../migrations")]
async fn explicit_limits_override_queue_defaults(pool: PgPool) {
    make_queue(&pool, "email").await;
    let mut new = NewJob::new("email", "email.send", json!({}), t0());
    new.max_attempts = Some(1);
    new.lease_seconds = Some(5);
    new.priority = 9;
    let job = add_job_with(&pool, new, t0()).await;
    assert_eq!(job.max_attempts, 1);
    assert_eq!(job.lease_seconds, 5);
    assert_eq!(job.priority, 9);
}

#[sqlx::test(migrations = "../../migrations")]
async fn past_run_at_becomes_now(pool: PgPool) {
    make_queue(&pool, "email").await;
    let job = add_job(&pool, "email", "email.send", t0() - secs(3600)).await;
    assert_eq!(job.run_at, t0());
    let later = add_job(&pool, "email", "email.send", t0() + secs(60)).await;
    assert_eq!(later.run_at, t0() + secs(60));
}

#[sqlx::test(migrations = "../../migrations")]
async fn unknown_queue_is_rejected(pool: PgPool) {
    let new = NewJob::new("missing", "email.send", json!({}), t0());
    let err = enqueue(&pool, &new, t0()).await.unwrap_err();
    assert!(matches!(err, StoreError::UnknownQueue(q) if q == "missing"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn unique_key_returns_the_live_job(pool: PgPool) {
    make_queue(&pool, "email").await;
    let first = enqueue(&pool, &keyed("email", "welcome:42", json!({"v": 1})), t0())
        .await
        .unwrap();
    assert!(!first.deduplicated);

    let second = enqueue(&pool, &keyed("email", "welcome:42", json!({"v": 2})), t0())
        .await
        .unwrap();
    assert!(second.deduplicated);
    assert_eq!(second.job.id, first.job.id);
    assert_eq!(second.job.payload, json!({"v": 1}));

    sqlx::query(
        "UPDATE jobs SET state = 'running', lease_owner = 'w', lease_expires_at = $2 \
         WHERE id = $1",
    )
    .bind(first.job.id)
    .bind(t0() + secs(60))
    .execute(&pool)
    .await
    .unwrap();
    let third = enqueue(&pool, &keyed("email", "welcome:42", json!({"v": 3})), t0())
        .await
        .unwrap();
    assert!(third.deduplicated);
    assert_eq!(third.job.id, first.job.id);
}

#[sqlx::test(migrations = "../../migrations")]
async fn unique_key_is_free_again_after_the_job_finishes(pool: PgPool) {
    make_queue(&pool, "email").await;
    let first = enqueue(&pool, &keyed("email", "k", json!({})), t0())
        .await
        .unwrap();
    force_succeeded(&pool, first.job.id, t0()).await;

    let second = enqueue(&pool, &keyed("email", "k", json!({})), t0())
        .await
        .unwrap();
    assert!(!second.deduplicated);
    assert_ne!(second.job.id, first.job.id);
}

#[sqlx::test(migrations = "../../migrations")]
async fn same_unique_key_on_two_queues_creates_two_jobs(pool: PgPool) {
    make_queue(&pool, "email").await;
    make_queue(&pool, "sms").await;
    let a = enqueue(&pool, &keyed("email", "k", json!({})), t0())
        .await
        .unwrap();
    let b = enqueue(&pool, &keyed("sms", "k", json!({})), t0())
        .await
        .unwrap();
    assert!(!a.deduplicated);
    assert!(!b.deduplicated);
    assert_ne!(a.job.id, b.job.id);
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_enqueues_with_one_key_create_one_job(pool: PgPool) {
    make_queue(&pool, "email").await;
    let mut handles = Vec::new();
    for i in 0..50 {
        let pool = pool.clone();
        handles.push(tokio::spawn(async move {
            enqueue(&pool, &keyed("email", "once", json!({ "caller": i })), t0())
                .await
                .unwrap()
        }));
    }
    let mut ids = Vec::new();
    let mut created = 0;
    for handle in handles {
        let enqueued = handle.await.unwrap();
        if !enqueued.deduplicated {
            created += 1;
        }
        ids.push(enqueued.job.id);
    }
    assert_eq!(created, 1);
    assert!(ids.iter().all(|id| *id == ids[0]));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE unique_key = 'once'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
