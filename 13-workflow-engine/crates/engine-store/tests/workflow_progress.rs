mod common;

use std::collections::HashMap;

use common::*;
use engine_core::clock::FixedJitter;
use engine_core::dag::StepDef;
use engine_core::outcome::FailureKind;
use engine_store::claim::{claim, ClaimedJob};
use engine_store::jobs::get_job;
use engine_store::lease::{complete, fail};
use engine_store::progress::{cancel_run, retry_run};
use engine_store::reaper::reap_expired;
use engine_store::workflows::{create_definition, get_run_detail, start_run, RunDetail};
use engine_store::StoreError;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

const NEUTRAL: FixedJitter = FixedJitter(0.5);

fn step(key: &str, deps: &[&str]) -> StepDef {
    StepDef {
        key: key.to_string(),
        kind: format!("step.{key}"),
        queue: "q".to_string(),
        depends_on: deps.iter().map(|d| d.to_string()).collect(),
        params: json!({}),
        max_attempts: Some(1),
        lease_seconds: None,
        priority: None,
    }
}

async fn start(pool: &PgPool, steps: &[StepDef]) -> Uuid {
    make_queue(pool, "q").await;
    let definition = create_definition(pool, "wf", steps, t0()).await.unwrap();
    start_run(pool, &definition, &json!({ "order": 42 }), None, t0())
        .await
        .unwrap()
        .run
        .id
}

async fn claim_step(pool: &PgPool, key: &str) -> ClaimedJob {
    let mut jobs = claim(pool, "q", &[format!("step.{key}")], WORKER_A, 1, t0())
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1, "step {key} has no claimable job");
    jobs.remove(0)
}

async fn finish_step(pool: &PgPool, key: &str, output: Value) {
    let job = claim_step(pool, key).await;
    complete(pool, &job.claim_ref(), &output, t0()).await.unwrap();
}

async fn detail(pool: &PgPool, run_id: Uuid) -> RunDetail {
    get_run_detail(pool, run_id).await.unwrap()
}

fn states(detail: &RunDetail) -> HashMap<String, String> {
    detail
        .steps
        .iter()
        .map(|s| (s.step_key.clone(), s.state.clone()))
        .collect()
}

fn state_of(detail: &RunDetail, key: &str) -> String {
    states(detail)[key].clone()
}

async fn jobs_for_step(pool: &PgPool, run_id: Uuid, key: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM jobs WHERE workflow_run_id = $1 AND step_key = $2")
        .bind(run_id)
        .bind(key)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_linear_chain_passes_outputs_along(pool: PgPool) {
    let run_id = start(&pool, &[step("a", &[]), step("b", &["a"]), step("c", &["b"])]).await;
    finish_step(&pool, "a", json!({ "rows": 10 })).await;

    let after_a = detail(&pool, run_id).await;
    assert_eq!(state_of(&after_a, "a"), "succeeded");
    assert_eq!(state_of(&after_a, "b"), "queued");
    assert_eq!(state_of(&after_a, "c"), "blocked");
    let b_job = claim_step(&pool, "b").await;
    assert_eq!(
        b_job.payload,
        json!({ "input": { "order": 42 }, "params": {}, "parents": { "a": { "rows": 10 } } })
    );
    complete(&pool, &b_job.claim_ref(), &json!("b done"), t0())
        .await
        .unwrap();
    finish_step(&pool, "c", json!("c done")).await;

    let done = detail(&pool, run_id).await;
    assert_eq!(done.run.state, "succeeded");
    assert_eq!(done.run.finished_at, Some(t0()));
    let outputs: HashMap<_, _> = done
        .steps
        .iter()
        .map(|s| (s.step_key.as_str(), s.output.clone()))
        .collect();
    assert_eq!(outputs["b"], Some(json!("b done")));
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_diamond_enqueues_the_join_once_after_concurrent_parents(pool: PgPool) {
    let run_id = start(
        &pool,
        &[step("a", &[]), step("b", &["a"]), step("c", &["a"]), step("d", &["b", "c"])],
    )
    .await;
    finish_step(&pool, "a", json!("A")).await;
    let b = claim_step(&pool, "b").await;
    let c = claim_step(&pool, "c").await;

    let pool_b = pool.clone();
    let pool_c = pool.clone();
    let done_b = tokio::spawn(async move {
        complete(&pool_b, &b.claim_ref(), &json!("B"), t0()).await.unwrap()
    });
    let done_c = tokio::spawn(async move {
        complete(&pool_c, &c.claim_ref(), &json!("C"), t0()).await.unwrap()
    });
    done_b.await.unwrap();
    done_c.await.unwrap();

    assert_eq!(jobs_for_step(&pool, run_id, "d").await, 1);
    let d = claim_step(&pool, "d").await;
    assert_eq!(d.payload["parents"], json!({ "b": "B", "c": "C" }));
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_duplicate_completion_records_one_output_and_enqueues_children_once(pool: PgPool) {
    let run_id = start(&pool, &[step("a", &[]), step("b", &["a"])]).await;
    let a = claim_step(&pool, "a").await;
    complete(&pool, &a.claim_ref(), &json!("first"), t0()).await.unwrap();
    let err = complete(&pool, &a.claim_ref(), &json!("second"), t0())
        .await
        .unwrap_err();
    assert!(matches!(err, StoreError::LeaseLost));
    let d = detail(&pool, run_id).await;
    let a_step = d.steps.iter().find(|s| s.step_key == "a").unwrap();
    assert_eq!(a_step.output, Some(json!("first")));
    assert_eq!(jobs_for_step(&pool, run_id, "b").await, 1);
}

/// Roots x, y and z, with w depending on x.
fn fan() -> Vec<StepDef> {
    vec![step("x", &[]), step("y", &[]), step("z", &[]), step("w", &["x"])]
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_failed_step_skips_blocked_steps_and_stops_siblings(pool: PgPool) {
    let run_id = start(&pool, &fan()).await;
    let x = claim_step(&pool, "x").await;
    let y = claim_step(&pool, "y").await;

    fail(&pool, &x.claim_ref(), FailureKind::Retryable, "boom", t0(), &NEUTRAL)
        .await
        .unwrap();
    let mid = detail(&pool, run_id).await;
    assert_eq!(state_of(&mid, "x"), "failed");
    assert_eq!(state_of(&mid, "w"), "skipped");
    assert_eq!(state_of(&mid, "z"), "cancelled");
    assert_eq!(state_of(&mid, "y"), "queued");
    assert_eq!(mid.run.state, "running");
    let y_job = get_job(&pool, y.id).await.unwrap();
    assert!(y_job.cancel_requested);
    let z_job_id = mid.steps.iter().find(|s| s.step_key == "z").unwrap().job_id.unwrap();
    assert_eq!(job_state(&pool, z_job_id).await, "cancelled");

    complete(&pool, &y.claim_ref(), &json!("late but fine"), t0())
        .await
        .unwrap();
    let end = detail(&pool, run_id).await;
    assert_eq!(state_of(&end, "y"), "succeeded");
    assert_eq!(end.run.state, "failed");
    assert_eq!(jobs_for_step(&pool, run_id, "w").await, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn retrying_a_failed_run_reruns_only_failed_and_cancelled_steps(pool: PgPool) {
    let run_id = start(&pool, &fan()).await;
    let x = claim_step(&pool, "x").await;
    let y = claim_step(&pool, "y").await;
    fail(&pool, &x.claim_ref(), FailureKind::Permanent, "bad", t0(), &NEUTRAL)
        .await
        .unwrap();
    complete(&pool, &y.claim_ref(), &json!("Y"), t0()).await.unwrap();
    assert_eq!(detail(&pool, run_id).await.run.state, "failed");

    let retried = retry_run(&pool, run_id, t0()).await.unwrap();
    assert_eq!(retried.run.state, "running");
    assert_eq!(retried.run.finished_at, None);
    assert_eq!(state_of(&retried, "x"), "queued");
    assert_eq!(state_of(&retried, "z"), "queued");
    assert_eq!(state_of(&retried, "w"), "blocked");
    assert_eq!(state_of(&retried, "y"), "succeeded");
    assert_eq!(job_state(&pool, y.id).await, "succeeded");

    let x_again = claim_step(&pool, "x").await;
    assert_eq!(x_again.id, x.id);
    assert_eq!(x_again.attempt, 1);
    complete(&pool, &x_again.claim_ref(), &json!("X"), t0()).await.unwrap();
    finish_step(&pool, "z", json!("Z")).await;
    let w = claim_step(&pool, "w").await;
    assert_eq!(w.payload["parents"], json!({ "x": "X" }));
    complete(&pool, &w.claim_ref(), &json!("W"), t0()).await.unwrap();
    assert_eq!(detail(&pool, run_id).await.run.state, "succeeded");
}

#[sqlx::test(migrations = "../../migrations")]
async fn cancelling_a_run_waits_for_the_running_step(pool: PgPool) {
    let run_id = start(&pool, &[step("a", &[]), step("b", &[]), step("c", &["a"])]).await;
    let a = claim_step(&pool, "a").await;

    let cancelled = cancel_run(&pool, run_id, t0()).await.unwrap();
    assert_eq!(cancelled.run.state, "running");
    assert!(cancelled.run.cancel_requested);
    assert_eq!(state_of(&cancelled, "b"), "cancelled");
    assert_eq!(state_of(&cancelled, "c"), "cancelled");
    assert_eq!(state_of(&cancelled, "a"), "queued");
    assert!(get_job(&pool, a.id).await.unwrap().cancel_requested);

    complete(&pool, &a.claim_ref(), &json!("A"), t0()).await.unwrap();
    let end = detail(&pool, run_id).await;
    assert_eq!(state_of(&end, "a"), "succeeded");
    assert_eq!(end.run.state, "cancelled");
    assert_eq!(jobs_for_step(&pool, run_id, "c").await, 0);

    let err = cancel_run(&pool, run_id, t0()).await.unwrap_err();
    assert!(matches!(err, StoreError::InvalidState(_)));
    let err = retry_run(&pool, run_id, t0()).await.unwrap_err();
    assert!(matches!(err, StoreError::InvalidState(_)));
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_cancelled_run_whose_running_step_fails_ends_cancelled(pool: PgPool) {
    let run_id = start(&pool, &[step("a", &[]), step("b", &["a"])]).await;
    let a = claim_step(&pool, "a").await;
    cancel_run(&pool, run_id, t0()).await.unwrap();
    fail(&pool, &a.claim_ref(), FailureKind::Cancelled, "stopped", t0(), &NEUTRAL)
        .await
        .unwrap();
    let end = detail(&pool, run_id).await;
    assert_eq!(state_of(&end, "a"), "cancelled");
    assert_eq!(end.run.state, "cancelled");
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_workflow_of_roots_succeeds_when_every_root_does(pool: PgPool) {
    let run_id = start(&pool, &[step("x", &[]), step("y", &[]), step("z", &[])]).await;
    for key in ["x", "y"] {
        finish_step(&pool, key, json!(key)).await;
        assert_eq!(detail(&pool, run_id).await.run.state, "running");
    }
    finish_step(&pool, "z", json!("z")).await;
    assert_eq!(detail(&pool, run_id).await.run.state, "succeeded");
}

#[sqlx::test(migrations = "../../migrations")]
async fn an_expired_lease_on_the_last_attempt_fails_the_step(pool: PgPool) {
    let run_id = start(&pool, &[step("a", &[]), step("b", &["a"])]).await;
    claim_step(&pool, "a").await;
    let reaped = reap_expired(&pool, t0() + secs(60), &NEUTRAL).await.unwrap();
    assert_eq!(reaped, 1);
    let end = detail(&pool, run_id).await;
    assert_eq!(state_of(&end, "a"), "failed");
    assert_eq!(state_of(&end, "b"), "skipped");
    assert_eq!(end.run.state, "failed");
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_completions_and_cancel_leave_a_consistent_run(pool: PgPool) {
    for round in 0..5 {
        let definition_steps = [step("a", &[]), step("b", &[]), step("c", &["a", "b"])];
        let run_id = if round == 0 {
            start(&pool, &definition_steps).await
        } else {
            let definition = engine_store::workflows::find_definition(&pool, "wf", None)
                .await
                .unwrap();
            start_run(&pool, &definition, &json!({}), None, t0())
                .await
                .unwrap()
                .run
                .id
        };
        let a = claim_step(&pool, "a").await;
        let b = claim_step(&pool, "b").await;
        let (pa, pb, pc) = (pool.clone(), pool.clone(), pool.clone());
        let ta = tokio::spawn(async move { complete(&pa, &a.claim_ref(), &json!(1), t0()).await });
        let tb = tokio::spawn(async move { complete(&pb, &b.claim_ref(), &json!(2), t0()).await });
        let tc = tokio::spawn(async move { cancel_run(&pc, run_id, t0()).await });
        ta.await.unwrap().unwrap();
        tb.await.unwrap().unwrap();
        match tc.await.unwrap() {
            Ok(_) | Err(StoreError::InvalidState(_)) => {}
            Err(other) => panic!("cancel failed: {other}"),
        }

        let end = detail(&pool, run_id).await;
        let c_jobs = jobs_for_step(&pool, run_id, "c").await;
        assert!(c_jobs <= 1);
        if end.run.cancel_requested {
            if c_jobs == 1 {
                let c_id = end.steps.iter().find(|s| s.step_key == "c").unwrap().job_id;
                let c_state = job_state(&pool, c_id.unwrap()).await;
                assert_eq!(c_state, "cancelled");
            }
            assert_eq!(end.run.state, "cancelled");
        } else {
            assert_eq!(end.run.state, "running");
            assert_eq!(c_jobs, 1);
            finish_step(&pool, "c", json!(3)).await;
            assert_eq!(detail(&pool, run_id).await.run.state, "succeeded");
        }
    }
}
