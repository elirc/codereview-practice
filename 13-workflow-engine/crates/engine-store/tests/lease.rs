mod common;

use chrono::Duration;
use common::*;
use engine_core::clock::FixedJitter;
use engine_core::outcome::{FailureKind, RESULT_TOO_LARGE};
use engine_core::state::JobState;
use engine_store::claim::{claim, ClaimedJob};
use engine_store::jobs::{get_job, list_attempts, NewJob};
use engine_store::lease::{complete, fail, heartbeat, release, Completion};
use engine_store::reaper::reap_expired;
use engine_store::StoreError;
use serde_json::json;
use sqlx::PgPool;

const NEUTRAL: FixedJitter = FixedJitter(0.5);

async fn claim_one(pool: &PgPool, worker: &str, at: chrono::DateTime<chrono::Utc>) -> ClaimedJob {
    let mut claimed = claim(pool, "q", &kinds(&["work"]), worker, 1, at)
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1, "expected one claimable job");
    claimed.remove(0)
}

async fn setup(pool: &PgPool, max_attempts: i32) -> uuid::Uuid {
    make_queue(pool, "q").await;
    let mut new = NewJob::new("q", "work", json!({}), t0());
    new.max_attempts = Some(max_attempts);
    add_job_with(pool, new, t0()).await.id
}

#[sqlx::test(migrations = "../../migrations")]
async fn heartbeat_extends_the_lease(pool: PgPool) {
    let id = setup(&pool, 3).await;
    let c = claim_one(&pool, WORKER_A, t0()).await;
    let cancel = heartbeat(&pool, &c.claim_ref(), t0() + secs(20)).await.unwrap();
    assert!(!cancel);
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.lease_expires_at, Some(t0() + secs(80)));
    assert_eq!(job.heartbeat_at, Some(t0() + secs(20)));
}

#[sqlx::test(migrations = "../../migrations")]
async fn heartbeat_after_expiry_is_accepted_while_the_claim_still_holds(pool: PgPool) {
    let id = setup(&pool, 3).await;
    let c = claim_one(&pool, WORKER_A, t0()).await;
    heartbeat(&pool, &c.claim_ref(), t0() + secs(75)).await.unwrap();
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.lease_expires_at, Some(t0() + secs(135)));
}

#[sqlx::test(migrations = "../../migrations")]
async fn superseded_claim_cannot_write_after_reclaim(pool: PgPool) {
    let id = setup(&pool, 3).await;
    let first = claim_one(&pool, WORKER_A, t0()).await;

    assert_eq!(reap_expired(&pool, t0() + secs(60), &NEUTRAL).await.unwrap(), 1);
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.state, "pending");
    assert_eq!(job.run_at, t0() + secs(61));

    let second = claim_one(&pool, WORKER_B, t0() + secs(62)).await;
    assert_eq!(second.lease_epoch, first.lease_epoch + 1);
    assert_eq!(second.attempt, 2);

    let stale = first.claim_ref();
    let err = heartbeat(&pool, &stale, t0() + secs(63)).await.unwrap_err();
    assert!(matches!(err, StoreError::LeaseLost));
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.lease_expires_at, Some(t0() + secs(122)));
    assert_eq!(job.lease_owner.as_deref(), Some(WORKER_B));

    let err = complete(&pool, &stale, &json!({"from": "a"}), t0() + secs(64))
        .await
        .unwrap_err();
    assert!(matches!(err, StoreError::LeaseLost));
    let err = fail(&pool, &stale, FailureKind::Retryable, "x", t0() + secs(64), &NEUTRAL)
        .await
        .unwrap_err();
    assert!(matches!(err, StoreError::LeaseLost));
    let err = release(&pool, &stale, t0() + secs(64)).await.unwrap_err();
    assert!(matches!(err, StoreError::LeaseLost));
    assert_eq!(job_state(&pool, id).await, "running");

    let done = complete(&pool, &second.claim_ref(), &json!({"from": "b"}), t0() + secs(65))
        .await
        .unwrap();
    assert_eq!(done, Completion::Succeeded);
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.state, "succeeded");
    assert_eq!(job.result, Some(json!({"from": "b"})));

    let attempts = list_attempts(&pool, id).await.unwrap();
    let outcomes: Vec<_> = attempts.iter().map(|a| a.outcome.clone()).collect();
    assert_eq!(
        outcomes,
        vec![Some("lease_expired".to_string()), Some("succeeded".to_string())]
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn late_completion_before_reclaim_is_accepted(pool: PgPool) {
    let id = setup(&pool, 3).await;
    let c = claim_one(&pool, WORKER_A, t0()).await;
    let done = complete(&pool, &c.claim_ref(), &json!(1), t0() + secs(90))
        .await
        .unwrap();
    assert_eq!(done, Completion::Succeeded);
    assert_eq!(job_state(&pool, id).await, "succeeded");
    assert_eq!(reap_expired(&pool, t0() + secs(120), &NEUTRAL).await.unwrap(), 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn completing_twice_is_rejected_and_changes_nothing(pool: PgPool) {
    let id = setup(&pool, 3).await;
    let c = claim_one(&pool, WORKER_A, t0()).await;
    complete(&pool, &c.claim_ref(), &json!("first"), t0() + secs(1))
        .await
        .unwrap();
    let err = complete(&pool, &c.claim_ref(), &json!("second"), t0() + secs(2))
        .await
        .unwrap_err();
    assert!(matches!(err, StoreError::LeaseLost));
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.result, Some(json!("first")));
    assert_eq!(job.finished_at, Some(t0() + secs(1)));
}

#[sqlx::test(migrations = "../../migrations")]
async fn reaper_takes_leases_at_exactly_their_expiry(pool: PgPool) {
    let id = setup(&pool, 3).await;
    claim_one(&pool, WORKER_A, t0()).await;
    let expiry = t0() + secs(60);
    let just_before = expiry - Duration::milliseconds(1);
    assert_eq!(reap_expired(&pool, just_before, &NEUTRAL).await.unwrap(), 0);
    assert_eq!(job_state(&pool, id).await, "running");
    assert_eq!(reap_expired(&pool, expiry, &NEUTRAL).await.unwrap(), 1);
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.state, "pending");
    assert_eq!(job.attempt, 1);
    assert_eq!(job.lease_owner, None);
    assert_eq!(job.lease_expires_at, None);
}

#[sqlx::test(migrations = "../../migrations")]
async fn lease_expiring_on_the_last_attempt_kills_the_job(pool: PgPool) {
    let id = setup(&pool, 1).await;
    claim_one(&pool, WORKER_A, t0()).await;
    reap_expired(&pool, t0() + secs(60), &NEUTRAL).await.unwrap();
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.state, "dead");
    assert_eq!(job.dead_reason.as_deref(), Some("lease_expired"));
    assert_eq!(job.finished_at, Some(t0() + secs(60)));
}

#[sqlx::test(migrations = "../../migrations")]
async fn retryable_failure_backs_off_then_exhausts(pool: PgPool) {
    let id = setup(&pool, 2).await;
    let first = claim_one(&pool, WORKER_A, t0()).await;
    let state = fail(&pool, &first.claim_ref(), FailureKind::Retryable, "boom", t0(), &NEUTRAL)
        .await
        .unwrap();
    assert_eq!(state, JobState::Pending);
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.run_at, t0() + secs(1));
    assert_eq!(job.last_error.as_deref(), Some("boom"));

    let second = claim_one(&pool, WORKER_A, t0() + secs(1)).await;
    let state = fail(
        &pool,
        &second.claim_ref(),
        FailureKind::Retryable,
        "boom again",
        t0() + secs(2),
        &NEUTRAL,
    )
    .await
    .unwrap();
    assert_eq!(state, JobState::Dead);
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.dead_reason.as_deref(), Some("attempts_exhausted"));
    let attempts = list_attempts(&pool, id).await.unwrap();
    assert_eq!(attempts.len(), 2);
    assert!(attempts
        .iter()
        .all(|a| a.outcome.as_deref() == Some("retryable_error")));
}

#[sqlx::test(migrations = "../../migrations")]
async fn permanent_failure_on_the_first_attempt_kills_the_job(pool: PgPool) {
    let id = setup(&pool, 5).await;
    let c = claim_one(&pool, WORKER_A, t0()).await;
    let state = fail(&pool, &c.claim_ref(), FailureKind::Permanent, "bad", t0(), &NEUTRAL)
        .await
        .unwrap();
    assert_eq!(state, JobState::Dead);
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.dead_reason.as_deref(), Some("permanent_failure"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn long_error_messages_are_truncated(pool: PgPool) {
    let id = setup(&pool, 5).await;
    let c = claim_one(&pool, WORKER_A, t0()).await;
    let long = "x".repeat(5000);
    fail(&pool, &c.claim_ref(), FailureKind::Retryable, &long, t0(), &NEUTRAL)
        .await
        .unwrap();
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.last_error.unwrap().chars().count(), 2000);
}

#[sqlx::test(migrations = "../../migrations")]
async fn release_restores_the_attempt(pool: PgPool) {
    let id = setup(&pool, 3).await;
    let c = claim_one(&pool, WORKER_A, t0()).await;
    let state = release(&pool, &c.claim_ref(), t0() + secs(10)).await.unwrap();
    assert_eq!(state, JobState::Pending);
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.attempt, 0);
    assert_eq!(job.run_at, t0() + secs(10));
    assert_eq!(job.lease_owner, None);
    let attempts = list_attempts(&pool, id).await.unwrap();
    assert_eq!(attempts[0].outcome.as_deref(), Some("released"));

    let again = claim_one(&pool, WORKER_B, t0() + secs(10)).await;
    assert_eq!(again.attempt, 1);
    assert_eq!(again.lease_epoch, 2);
}

#[sqlx::test(migrations = "../../migrations")]
async fn oversized_result_kills_the_job(pool: PgPool) {
    let id = setup(&pool, 5).await;
    let c = claim_one(&pool, WORKER_A, t0()).await;
    let big = json!("y".repeat(262_144));
    let done = complete(&pool, &c.claim_ref(), &big, t0()).await.unwrap();
    assert_eq!(done, Completion::ResultTooLarge);
    let job = get_job(&pool, id).await.unwrap();
    assert_eq!(job.state, "dead");
    assert_eq!(job.dead_reason.as_deref(), Some("permanent_failure"));
    assert_eq!(job.last_error.as_deref(), Some(RESULT_TOO_LARGE));
    assert_eq!(job.result, None);
}
