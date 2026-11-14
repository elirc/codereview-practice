mod common;

use axum::http::StatusCode;
use common::*;
use engine_core::authz::Role;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrations = "../../migrations")]
async fn cancel_pending_running_and_finished_jobs(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    app.queue(&admin, "email").await;

    let pending = app.job(&admin, "email").await;
    let reply = app
        .post(&format!("/api/jobs/{pending}/cancel"), &admin, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["state"], "cancelled");

    let reply = app
        .post(&format!("/api/jobs/{pending}/cancel"), &admin, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(error_code(&reply), "invalid_state");

    let running = app.job(&admin, "email").await;
    engine_store::claim::claim(&pool, "email", &["email.send".to_string()], "w1", 1, t0())
        .await
        .unwrap();
    let reply = app
        .post(&format!("/api/jobs/{running}/cancel"), &admin, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED);
    assert_eq!(reply.body["state"], "running");
    assert_eq!(reply.body["cancel_requested"], true);
}

#[sqlx::test(migrations = "../../migrations")]
async fn requeue_requires_a_dead_job_and_an_operator(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    let operator = token(&pool, Role::Operator, &[]).await;
    let submitter = token(&pool, Role::Submitter, &["email"]).await;
    app.queue(&admin, "email").await;
    let job = app.job(&admin, "email").await;

    let reply = app
        .post(&format!("/api/jobs/{job}/requeue"), &submitter, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);

    let reply = app
        .post(&format!("/api/jobs/{job}/requeue"), &operator, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(error_code(&reply), "invalid_state");

    sqlx::query(
        "UPDATE jobs SET state = 'dead', dead_reason = 'permanent_failure', finished_at = $2 \
         WHERE id = $1::uuid",
    )
    .bind(&job)
    .bind(t0())
    .execute(&pool)
    .await
    .unwrap();
    let reply = app
        .post(&format!("/api/jobs/{job}/requeue"), &operator, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["state"], "pending");
    assert_eq!(reply.body["attempt"], 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn cancel_respects_roles_and_queue_scope(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    let viewer = token(&pool, Role::Viewer, &[]).await;
    let submitter = token(&pool, Role::Submitter, &["email"]).await;
    app.queue(&admin, "email").await;
    app.queue(&admin, "billing").await;
    let own = app.job(&submitter, "email").await;
    let foreign = app.job(&admin, "billing").await;

    let reply = app
        .post(&format!("/api/jobs/{own}/cancel"), &viewer, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);

    let reply = app
        .post(&format!("/api/jobs/{foreign}/cancel"), &submitter, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    let reply = app
        .post(&format!("/api/jobs/{own}/cancel"), &submitter, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
}
