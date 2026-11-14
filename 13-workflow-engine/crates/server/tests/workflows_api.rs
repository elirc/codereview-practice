mod common;

use axum::http::StatusCode;
use common::*;
use engine_core::authz::Role;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrations = "../../migrations")]
async fn invalid_definitions_are_422_with_problems(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    app.queue(&admin, "etl").await;
    let reply = app
        .post(
            "/api/workflow-definitions",
            &admin,
            json!({
                "name": "loop",
                "steps": [
                    { "key": "a", "kind": "noop", "queue": "etl", "depends_on": ["b"] },
                    { "key": "b", "kind": "noop", "queue": "etl", "depends_on": ["a"] },
                    { "key": "c", "kind": "noop", "queue": "nowhere" }
                ]
            }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_code(&reply), "invalid_workflow");
    let problems = reply.body["error"]["details"]["problems"].as_array().unwrap();
    assert!(problems.iter().any(|p| p["code"] == "cycle"));
    assert!(problems.iter().any(|p| p["code"] == "unknown_queue"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn submitters_start_and_see_only_runs_within_their_queues(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    let submitter = token(&pool, Role::Submitter, &["etl"]).await;
    app.queue(&admin, "etl").await;
    app.queue(&admin, "billing").await;

    for (name, second_queue) in [("local", "etl"), ("mixed", "billing")] {
        let reply = app
            .post(
                "/api/workflow-definitions",
                &admin,
                json!({
                    "name": name,
                    "steps": [
                        { "key": "a", "kind": "noop", "queue": "etl" },
                        { "key": "b", "kind": "noop", "queue": second_queue, "depends_on": ["a"] }
                    ]
                }),
            )
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    }

    let reply = app
        .post(
            "/api/workflow-runs",
            &submitter,
            json!({ "name": "mixed", "input": {} }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);

    let reply = app
        .post(
            "/api/workflow-runs",
            &submitter,
            json!({ "name": "local", "input": { "n": 1 } }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let own = reply.body["id"].as_str().unwrap().to_string();
    assert_eq!(reply.body["steps"][0]["state"], "queued");

    let reply = app
        .post("/api/workflow-runs", &admin, json!({ "name": "mixed", "input": {} }))
        .await;
    let foreign = reply.body["id"].as_str().unwrap().to_string();

    let reply = app.get(&format!("/api/workflow-runs/{foreign}"), &submitter).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = app.get("/api/workflow-runs", &submitter).await;
    let items = reply.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], own.as_str());

    let reply = app.get("/api/workflow-runs?state=running", &admin).await;
    assert_eq!(reply.body["items"].as_array().unwrap().len(), 2);
    let reply = app.get("/api/workflow-definitions/local", &submitter).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let reply = app.get("/api/workflow-definitions/local", &admin).await;
    assert_eq!(reply.body.as_array().unwrap().len(), 1);
}
