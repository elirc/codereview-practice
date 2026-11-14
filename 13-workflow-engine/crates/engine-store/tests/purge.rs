mod common;

use chrono::Duration;
use common::*;
use engine_core::dag::StepDef;
use engine_store::purge::purge_finished;
use engine_store::workflows::{create_definition, start_run};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

async fn exists(pool: &PgPool, table: &str, id: Uuid) -> bool {
    let sql = format!("SELECT count(*) FROM {table} WHERE id = $1");
    let count: i64 = sqlx::query_scalar(&sql)
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
    count == 1
}

fn days(n: i64) -> Duration {
    Duration::days(n)
}

#[sqlx::test(migrations = "../../migrations")]
async fn old_finished_jobs_go_and_recent_or_live_ones_stay(pool: PgPool) {
    make_queue(&pool, "q").await;
    let old = add_job(&pool, "q", "work", t0()).await;
    let recent = add_job(&pool, "q", "work", t0()).await;
    let pending = add_job(&pool, "q", "work", t0()).await;
    force_succeeded(&pool, old.id, t0() - days(15)).await;
    force_succeeded(&pool, recent.id, t0() - days(13)).await;

    let deleted = purge_finished(&pool, t0(), days(14)).await.unwrap();
    assert_eq!(deleted, 1);
    assert!(!exists(&pool, "jobs", old.id).await);
    assert!(exists(&pool, "jobs", recent.id).await);
    assert!(exists(&pool, "jobs", pending.id).await);
}

#[sqlx::test(migrations = "../../migrations")]
async fn jobs_of_a_running_run_stay_and_finished_runs_go_whole(pool: PgPool) {
    make_queue(&pool, "q").await;
    let steps = vec![StepDef {
        key: "a".to_string(),
        kind: "noop".to_string(),
        queue: "q".to_string(),
        depends_on: Vec::new(),
        params: json!({}),
        max_attempts: None,
        lease_seconds: None,
        priority: None,
    }];
    let definition = create_definition(&pool, "wf", &steps, t0()).await.unwrap();
    let live = start_run(&pool, &definition, &json!({}), None, t0()).await.unwrap();
    let done = start_run(&pool, &definition, &json!({}), None, t0()).await.unwrap();
    let live_job = live.steps[0].job_id.unwrap();
    let done_job = done.steps[0].job_id.unwrap();

    force_succeeded(&pool, live_job, t0() - days(30)).await;
    force_succeeded(&pool, done_job, t0() - days(30)).await;
    sqlx::query("UPDATE workflow_runs SET state = 'succeeded', finished_at = $2 WHERE id = $1")
        .bind(done.run.id)
        .bind(t0() - days(20))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = $1")
        .bind(done.run.id)
        .execute(&pool)
        .await
        .unwrap();

    purge_finished(&pool, t0(), days(14)).await.unwrap();
    assert!(exists(&pool, "jobs", live_job).await);
    assert!(exists(&pool, "workflow_runs", live.run.id).await);
    assert!(!exists(&pool, "workflow_runs", done.run.id).await);
    assert!(!exists(&pool, "jobs", done_job).await);
    let steps_left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM workflow_steps WHERE run_id = $1")
            .bind(done.run.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(steps_left, 0);
}
