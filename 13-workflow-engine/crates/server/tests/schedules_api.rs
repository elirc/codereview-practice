mod common;

use axum::http::StatusCode;
use common::*;
use engine_core::authz::Role;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrations = "../../migrations")]
async fn schedule_endpoints_validate_and_enforce_roles(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    let operator = token(&pool, Role::Operator, &[]).await;
    let viewer = token(&pool, Role::Viewer, &[]).await;
    let submitter = token(&pool, Role::Submitter, &["*"]).await;
    app.queue(&admin, "reports").await;

    let body = json!({
        "name": "nightly",
        "cron_expr": "0 0 2 * * Mon-Fri",
        "queue": "reports",
        "kind": "report.build",
        "catchup": "latest",
    });
    let reply = app.post("/api/schedules", &operator, body.clone()).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);

    let reply = app.post("/api/schedules", &admin, body.clone()).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert_eq!(reply.body["next_fire_at"], "2026-01-06T02:00:00Z");
    let id = reply.body["id"].as_str().unwrap().to_string();

    let reply = app.post("/api/schedules", &admin, body).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    let reply = app
        .post(
            "/api/schedules",
            &admin,
            json!({ "name": "bad", "cron_expr": "whenever", "queue": "reports", "kind": "k" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_code(&reply), "invalid_cron");

    let reply = app
        .post(
            "/api/schedules",
            &admin,
            json!({ "name": "lost", "cron_expr": "0 * * * * *", "queue": "nowhere", "kind": "k" }),
        )
        .await;
    assert_eq!(error_code(&reply), "unknown_queue");

    assert_eq!(app.get("/api/schedules", &viewer).await.status, StatusCode::OK);
    assert_eq!(
        app.get("/api/schedules", &submitter).await.status,
        StatusCode::FORBIDDEN
    );

    let reply = app
        .post(&format!("/api/schedules/{id}/pause"), &operator, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["paused"], true);

    let reply = app
        .patch(
            &format!("/api/schedules/{id}"),
            &admin,
            json!({ "cron_expr": "0 30 * * * *" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["next_fire_at"], "2026-01-05T12:30:00Z");

    let reply = app.delete(&format!("/api/schedules/{id}"), &admin).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let reply = app.get(&format!("/api/schedules/{id}"), &admin).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}
