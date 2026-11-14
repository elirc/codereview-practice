mod common;

use common::*;
use engine_core::dag::StepDef;
use engine_store::jobs::get_job;
use engine_store::workflows::{
    create_definition, find_definition, list_definition_versions, start_run,
};
use engine_store::StoreError;
use serde_json::json;
use sqlx::PgPool;

fn step(key: &str, queue: &str, deps: &[&str]) -> StepDef {
    StepDef {
        key: key.to_string(),
        kind: "noop".to_string(),
        queue: queue.to_string(),
        depends_on: deps.iter().map(|d| d.to_string()).collect(),
        params: json!({ "step": key }),
        max_attempts: None,
        lease_seconds: None,
        priority: None,
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn saving_a_definition_again_adds_a_version(pool: PgPool) {
    make_queue(&pool, "q").await;
    let first = create_definition(&pool, "etl", &[step("a", "q", &[])], t0())
        .await
        .unwrap();
    let second = create_definition(
        &pool,
        "etl",
        &[step("a", "q", &[]), step("b", "q", &["a"])],
        t0(),
    )
    .await
    .unwrap();
    assert_eq!(first.version, 1);
    assert_eq!(second.version, 2);
    assert_eq!(second.queues, vec!["q".to_string()]);
    let versions = list_definition_versions(&pool, "etl").await.unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(find_definition(&pool, "etl", None).await.unwrap().version, 2);
    assert_eq!(find_definition(&pool, "etl", Some(1)).await.unwrap().id, first.id);
    assert!(matches!(
        find_definition(&pool, "etl", Some(9)).await,
        Err(StoreError::NotFound)
    ));
}

#[sqlx::test(migrations = "../../migrations")]
async fn invalid_definitions_list_every_problem(pool: PgPool) {
    make_queue(&pool, "q").await;
    let steps = vec![
        step("a", "q", &["b"]),
        step("b", "q", &["a"]),
        step("b", "q", &[]),
        step("c", "q", &["ghost"]),
        step("d", "nowhere", &[]),
    ];
    let err = create_definition(&pool, "broken", &steps, t0()).await.unwrap_err();
    let StoreError::InvalidWorkflow(problems) = err else {
        panic!("expected an invalid workflow error");
    };
    let codes: Vec<&str> = problems.iter().map(|p| p.code.as_str()).collect();
    for expected in ["cycle", "duplicate_key", "unknown_dependency", "unknown_queue"] {
        assert!(codes.contains(&expected), "missing {expected}: {codes:?}");
    }
    assert!(list_definition_versions(&pool, "broken").await.unwrap().is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn starting_a_run_queues_only_the_roots(pool: PgPool) {
    make_queue(&pool, "q").await;
    let mut a = step("a", "q", &[]);
    a.max_attempts = Some(2);
    a.priority = Some(8);
    let definition = create_definition(
        &pool,
        "diamond",
        &[a, step("b", "q", &["a"]), step("c", "q", &["a"]), step("d", "q", &["b", "c"])],
        t0(),
    )
    .await
    .unwrap();

    let detail = start_run(&pool, &definition, &json!({ "order": 1 }), None, t0())
        .await
        .unwrap();
    assert_eq!(detail.run.state, "running");
    assert_eq!(detail.run.definition_name, "diamond");
    let states: Vec<(&str, &str)> = detail
        .steps
        .iter()
        .map(|s| (s.step_key.as_str(), s.state.as_str()))
        .collect();
    assert_eq!(
        states,
        vec![("a", "queued"), ("b", "blocked"), ("c", "blocked"), ("d", "blocked")]
    );

    let job_id = detail.steps[0].job_id.unwrap();
    let job = get_job(&pool, job_id).await.unwrap();
    assert_eq!(job.workflow_run_id, Some(detail.run.id));
    assert_eq!(job.step_key.as_deref(), Some("a"));
    assert_eq!(job.max_attempts, 2);
    assert_eq!(job.priority, 8);
    assert_eq!(job.lease_seconds, 60);
    assert_eq!(job.unique_key, None);
    assert_eq!(
        job.payload,
        json!({ "input": { "order": 1 }, "params": { "step": "a" }, "parents": {} })
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_workflow_of_roots_starts_every_job(pool: PgPool) {
    make_queue(&pool, "q").await;
    let definition = create_definition(
        &pool,
        "fanout",
        &[step("x", "q", &[]), step("y", "q", &[]), step("z", "q", &[])],
        t0(),
    )
    .await
    .unwrap();
    let detail = start_run(&pool, &definition, &json!(null), None, t0())
        .await
        .unwrap();
    assert!(detail.steps.iter().all(|s| s.state == "queued" && s.job_id.is_some()));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE workflow_run_id = $1")
        .bind(detail.run.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 3);
}
