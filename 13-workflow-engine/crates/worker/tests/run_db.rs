mod common;

use std::sync::Arc;

use async_trait::async_trait;
use chrono::Duration;
use common::*;
use engine_core::clock::{Clock, FixedClock};
use engine_core::outcome::HANDLER_PANICKED;
use engine_core::state::JobState;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio_util::sync::CancellationToken;
use wfe_worker::handlers::{Handler, HandlerError, JobContext};
use wfe_worker::runner::{run_job, RunOutcome};

#[sqlx::test(migrations = "../../migrations")]
async fn successful_handler_records_its_result(pool: PgPool) {
    make_queue(&pool).await;
    let clock = Arc::new(FixedClock::new(t0()));
    let registry = registry();
    let env = db_env(&pool, clock, registry.clone());
    let id = add_job(&pool, "noop", json!({ "hello": "world" })).await;

    let job = claim_next(&pool, &registry.kinds(), t0()).await;
    let outcome = run_job(env, job, CancellationToken::new()).await;
    assert_eq!(outcome, RunOutcome::Reported(JobState::Succeeded));
    let row = job_row(&pool, id).await;
    assert_eq!(row.state, "succeeded");
    assert_eq!(row.result, Some(json!({ "hello": "world" })));
}

#[sqlx::test(migrations = "../../migrations")]
async fn retryable_failure_then_success(pool: PgPool) {
    make_queue(&pool).await;
    let clock = Arc::new(FixedClock::new(t0()));
    let registry = registry();
    let env = db_env(&pool, clock.clone(), registry.clone());
    let id = add_job(
        &pool,
        "fail",
        json!({ "mode": "retryable", "succeed_on_attempt": 2 }),
    )
    .await;

    let first = claim_next(&pool, &registry.kinds(), t0()).await;
    let outcome = run_job(env.clone(), first, CancellationToken::new()).await;
    assert_eq!(outcome, RunOutcome::Reported(JobState::Pending));
    let row = job_row(&pool, id).await;
    assert_eq!(row.run_at, t0() + Duration::seconds(1));
    assert_eq!(row.last_error.as_deref(), Some("failed on attempt 1"));

    clock.advance(Duration::seconds(1));
    let second = claim_next(&pool, &registry.kinds(), clock.now()).await;
    let outcome = run_job(env, second, CancellationToken::new()).await;
    assert_eq!(outcome, RunOutcome::Reported(JobState::Succeeded));
    assert_eq!(job_row(&pool, id).await.result, Some(json!({ "attempt": 2 })));
}

#[sqlx::test(migrations = "../../migrations")]
async fn permanent_failure_kills_the_job(pool: PgPool) {
    make_queue(&pool).await;
    let clock = Arc::new(FixedClock::new(t0()));
    let registry = registry();
    let env = db_env(&pool, clock, registry.clone());
    let id = add_job(&pool, "fail", json!({ "mode": "permanent" })).await;

    let job = claim_next(&pool, &registry.kinds(), t0()).await;
    let outcome = run_job(env, job, CancellationToken::new()).await;
    assert_eq!(outcome, RunOutcome::Reported(JobState::Dead));
    let row = job_row(&pool, id).await;
    assert_eq!(row.dead_reason.as_deref(), Some("permanent_failure"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn handler_panic_is_retried_and_the_worker_carries_on(pool: PgPool) {
    make_queue(&pool).await;
    let clock = Arc::new(FixedClock::new(t0()));
    let mut registry = registry();
    registry.register("panics", Arc::new(Panics));
    let env = db_env(&pool, clock, registry);
    let panicking = add_job(&pool, "panics", json!({})).await;

    let job = claim_next(&pool, &["panics".to_string()], t0()).await;
    let outcome = run_job(env.clone(), job, CancellationToken::new()).await;
    assert_eq!(outcome, RunOutcome::Reported(JobState::Pending));
    let row = job_row(&pool, panicking).await;
    assert_eq!(row.last_error.as_deref(), Some(HANDLER_PANICKED));
    assert_eq!(row.attempt, 1);

    let healthy = add_job(&pool, "noop", json!(7)).await;
    let job = claim_next(&pool, &["noop".to_string()], t0()).await;
    assert_eq!(job.id, healthy);
    let outcome = run_job(env, job, CancellationToken::new()).await;
    assert_eq!(outcome, RunOutcome::Reported(JobState::Succeeded));
}

struct Panics;

#[async_trait]
impl Handler for Panics {
    async fn run(&self, ctx: JobContext) -> Result<Value, HandlerError> {
        if ctx.attempt > 0 {
            panic!("handler panic on attempt {}", ctx.attempt);
        }
        Ok(Value::Null)
    }
}

struct BigResult;

#[async_trait]
impl Handler for BigResult {
    async fn run(&self, _ctx: JobContext) -> Result<Value, HandlerError> {
        Ok(json!("z".repeat(300_000)))
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn oversized_result_is_a_permanent_failure(pool: PgPool) {
    make_queue(&pool).await;
    let clock = Arc::new(FixedClock::new(t0()));
    let mut registry = registry();
    registry.register("big", Arc::new(BigResult));
    let env = db_env(&pool, clock, registry);
    let id = add_job(&pool, "big", json!({})).await;

    let job = claim_next(&pool, &["big".to_string()], t0()).await;
    let outcome = run_job(env, job, CancellationToken::new()).await;
    assert_eq!(outcome, RunOutcome::Reported(JobState::Dead));
    assert_eq!(
        job_row(&pool, id).await.dead_reason.as_deref(),
        Some("permanent_failure")
    );
}
