mod common;

use axum::http::{Method, StatusCode};
use chrono::Duration;
use common::*;
use engine_core::authz::Role;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrations = "../../migrations")]
async fn admin_page_is_served_without_a_token(pool: PgPool) {
    let app = app(pool);
    let reply = app.send(Method::GET, "/", None, None, None).await;
    assert_eq!(reply.status, StatusCode::OK);
}

#[sqlx::test(migrations = "../../migrations")]
async fn queue_stats_count_jobs_and_tokens(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    let submitter = token(&pool, Role::Submitter, &["other"]).await;
    let reply = app
        .post(
            "/api/queues",
            &admin,
            json!({ "name": "mail", "rate_limit_per_minute": 60, "rate_burst": 4 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);

    let first = app.job(&admin, "mail").await;
    app.clock.advance(Duration::seconds(5));
    app.job(&admin, "mail").await;
    let reply = app
        .post(&format!("/api/jobs/{first}/cancel"), &admin, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::OK);

    let reply = app.get("/api/queues/mail/stats", &admin).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["counts"]["pending"], 1);
    assert_eq!(reply.body["counts"]["cancelled"], 1);
    assert_eq!(reply.body["counts"]["running"], 0);
    assert_eq!(
        reply.body["oldest_pending_run_at"],
        json!(t0() + Duration::seconds(5))
    );
    assert_eq!(reply.body["tokens_available"], 4);

    let reply = app.get("/api/queues/mail/stats", &submitter).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}
