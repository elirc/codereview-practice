mod common;

use common::*;
use engine_core::clock::FixedJitter;
use engine_core::outcome::FailureKind;
use engine_core::state::JobState;
use engine_store::claim::claim;
use engine_store::jobs::{cancel_job, enqueue, get_job, list_attempts, requeue_job, NewJob};
use engine_store::lease::{complete, fail, heartbeat, Completion};
use engine_store::reaper::reap_expired;
use engine_store::StoreError;
use serde_json::json;
use sqlx::PgPool;

const NEUTRAL: FixedJitter = FixedJitter(0.5);

#[sqlx::test(migrations = "../../migrations")]
async fn cancelled_pending_job_never_runs(pool: PgPool) {
    make_queue(&pool, "q").await;
    let job = add_job(&pool, "q", "work", t0()).await;
    let c = cancel_job(&pool, job.id, t0()).await.unwrap();
    assert!(c.immediate);
    assert_eq!(c.job.state, "cancelled");
    assert_eq!(c.job.finished_at, Some(t0()));
    assert!(claim(&pool, "q", &kinds(&["work"]), WORKER_A, 5, t0() + secs(5))
        .await
        .unwrap()
        .is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn cancelling_a_running_job_is_seen_at_the_next_heartbeat(pool: PgPool) {
    make_queue(&pool, "q").await;
    let job = add_job(&pool, "q", "work", t0()).await;
    let claimed = claim(&pool, "q", &kinds(&["work"]), WORKER_A, 1, t0())
        .await
        .unwrap()
        .remove(0);
    let c = cancel_job(&pool, job.id, t0()).await.unwrap();
    assert!(!c.immediate);
    assert_eq!(c.job.state, "running");
    assert!(c.job.cancel_requested);
    assert!(heartbeat(&pool, &claimed.claim_ref(), t0() + secs(1)).await.unwrap());

    let state = fail(
        &pool,
        &claimed.claim_ref(),
        FailureKind::Cancelled,
        "stopped",
        t0() + secs(2),
        &NEUTRAL,
    )
    .await
    .unwrap();
    assert_eq!(state, JobState::Cancelled);
    let attempts = list_attempts(&pool, job.id).await.unwrap();
    assert_eq!(attempts[0].outcome.as_deref(), Some("cancelled"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn cancel_requested_job_that_fails_is_not_retried(pool: PgPool) {
    make_queue(&pool, "q").await;
    let job = add_job(&pool, "q", "work", t0()).await;
    let claimed = claim(&pool, "q", &kinds(&["work"]), WORKER_A, 1, t0())
        .await
        .unwrap()
        .remove(0);
    cancel_job(&pool, job.id, t0()).await.unwrap();
    let state = fail(&pool, &claimed.claim_ref(), FailureKind::Retryable, "x", t0(), &NEUTRAL)
        .await
        .unwrap();
    assert_eq!(state, JobState::Cancelled);
}

#[sqlx::test(migrations = "../../migrations")]
async fn cancel_requested_job_whose_lease_expires_is_cancelled(pool: PgPool) {
    make_queue(&pool, "q").await;
    let job = add_job(&pool, "q", "work", t0()).await;
    claim(&pool, "q", &kinds(&["work"]), WORKER_A, 1, t0())
        .await
        .unwrap();
    cancel_job(&pool, job.id, t0()).await.unwrap();
    reap_expired(&pool, t0() + secs(60), &NEUTRAL).await.unwrap();
    assert_eq!(job_state(&pool, job.id).await, "cancelled");
}

#[sqlx::test(migrations = "../../migrations")]
async fn cancel_requested_job_that_succeeds_is_succeeded(pool: PgPool) {
    make_queue(&pool, "q").await;
    let job = add_job(&pool, "q", "work", t0()).await;
    let claimed = claim(&pool, "q", &kinds(&["work"]), WORKER_A, 1, t0())
        .await
        .unwrap()
        .remove(0);
    cancel_job(&pool, job.id, t0()).await.unwrap();
    let done = complete(&pool, &claimed.claim_ref(), &json!("ignored the token"), t0())
        .await
        .unwrap();
    assert_eq!(done, Completion::Succeeded);
    assert_eq!(job_state(&pool, job.id).await, "succeeded");
}

#[sqlx::test(migrations = "../../migrations")]
async fn finished_jobs_cannot_be_cancelled(pool: PgPool) {
    make_queue(&pool, "q").await;
    let job = add_job(&pool, "q", "work", t0()).await;
    force_succeeded(&pool, job.id, t0()).await;
    let err = cancel_job(&pool, job.id, t0()).await.unwrap_err();
    assert!(matches!(err, StoreError::InvalidState(_)));
    let err = cancel_job(&pool, uuid::Uuid::new_v4(), t0()).await.unwrap_err();
    assert!(matches!(err, StoreError::NotFound));
}

#[sqlx::test(migrations = "../../migrations")]
async fn cancel_racing_with_claim_never_leaves_a_job_running_unasked(pool: PgPool) {
    make_queue(&pool, "q").await;
    for _ in 0..20 {
        let job = add_job(&pool, "q", "work", t0()).await;
        let claim_pool = pool.clone();
        let cancel_pool = pool.clone();
        let claimer = tokio::spawn(async move {
            claim(&claim_pool, "q", &["work".to_string()], WORKER_A, 1, t0())
                .await
                .unwrap()
        });
        let canceller = tokio::spawn(async move { cancel_job(&cancel_pool, job.id, t0()).await });
        let claimed = claimer.await.unwrap();
        canceller.await.unwrap().unwrap();

        let row = get_job(&pool, job.id).await.unwrap();
        if claimed.is_empty() {
            assert_eq!(row.state, "cancelled");
            assert_eq!(row.attempt, 0);
        } else {
            assert_eq!(row.state, "running");
            assert!(row.cancel_requested);
            force_succeeded(&pool, job.id, t0()).await;
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn requeue_revives_a_dead_job_and_keeps_its_history(pool: PgPool) {
    make_queue(&pool, "q").await;
    let mut new = NewJob::new("q", "work", json!({}), t0());
    new.max_attempts = Some(1);
    let job = add_job_with(&pool, new, t0()).await;
    let claimed = claim(&pool, "q", &kinds(&["work"]), WORKER_A, 1, t0())
        .await
        .unwrap()
        .remove(0);
    fail(&pool, &claimed.claim_ref(), FailureKind::Permanent, "bad", t0(), &NEUTRAL)
        .await
        .unwrap();

    let revived = requeue_job(&pool, job.id, t0() + secs(30)).await.unwrap();
    assert_eq!(revived.state, "pending");
    assert_eq!(revived.attempt, 0);
    assert_eq!(revived.run_at, t0() + secs(30));
    assert_eq!(revived.dead_reason, None);
    assert_eq!(revived.last_error, None);
    assert_eq!(list_attempts(&pool, job.id).await.unwrap().len(), 1);

    let err = requeue_job(&pool, job.id, t0()).await.unwrap_err();
    assert!(matches!(err, StoreError::InvalidState(_)));
}

#[sqlx::test(migrations = "../../migrations")]
async fn requeue_fails_when_a_live_job_holds_the_key(pool: PgPool) {
    make_queue(&pool, "q").await;
    let mut new = NewJob::new("q", "work", json!({}), t0());
    new.unique_key = Some("report:1".to_string());
    new.max_attempts = Some(1);
    let dead = enqueue(&pool, &new, t0()).await.unwrap().job;
    let claimed = claim(&pool, "q", &kinds(&["work"]), WORKER_A, 1, t0())
        .await
        .unwrap()
        .remove(0);
    fail(&pool, &claimed.claim_ref(), FailureKind::Permanent, "bad", t0(), &NEUTRAL)
        .await
        .unwrap();

    let live = enqueue(&pool, &new, t0()).await.unwrap();
    assert!(!live.deduplicated);

    let err = requeue_job(&pool, dead.id, t0()).await.unwrap_err();
    assert!(matches!(err, StoreError::UniqueKeyConflict));
    assert_eq!(job_state(&pool, dead.id).await, "dead");
}
