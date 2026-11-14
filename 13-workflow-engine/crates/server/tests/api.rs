mod common;

use axum::http::{Method, StatusCode};
use chrono::Duration;
use common::*;
use engine_core::authz::Role;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrations = "../../migrations")]
async fn health_needs_no_token(pool: PgPool) {
    let app = app(pool);
    let reply = app
        .send(Method::GET, "/api/healthz", None, None, None)
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["status"], "ok");
}

#[sqlx::test(migrations = "../../migrations")]
async fn missing_or_unknown_token_is_unauthenticated(pool: PgPool) {
    let app = app(pool);
    let reply = app.send(Method::GET, "/api/queues", None, None, None).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(&reply), "unauthenticated");
    let error = &reply.body["error"];
    assert!(error["message"].is_string());
    assert!(error["details"].is_object());
    assert!(!error["requestId"].as_str().unwrap().is_empty());

    let reply = app.get("/api/queues", "wfe_not_a_real_token").await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrations = "../../migrations")]
async fn inbound_request_id_is_echoed(pool: PgPool) {
    let app = app(pool);
    let reply = app
        .send(Method::GET, "/api/queues", None, None, Some("req-123"))
        .await;
    assert_eq!(reply.body["error"]["requestId"], "req-123");
    assert_eq!(reply.request_id.as_deref(), Some("req-123"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn unknown_route_uses_the_envelope(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    let reply = app.get("/api/nothing-here", &admin).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&reply), "not_found");
}

#[sqlx::test(migrations = "../../migrations")]
async fn unknown_fields_and_bad_values_fail_validation(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;

    let reply = app
        .post("/api/queues", &admin, json!({ "name": "email", "colour": "red" }))
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&reply), "validation_failed");

    let reply = app
        .post(
            "/api/queues",
            &admin,
            json!({ "name": "Bad Name", "default_max_attempts": 51, "rate_limit_per_minute": 5 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    let paths: Vec<&str> = reply.body["error"]["details"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"name"));
    assert!(paths.contains(&"default_max_attempts"));
    assert!(paths.contains(&"rate_burst"));

    app.queue(&admin, "email").await;
    let reply = app
        .post(
            "/api/jobs",
            &admin,
            json!({ "queue": "email", "kind": "email.send", "payload": {}, "priority": 10 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["error"]["details"]["fields"][0]["path"], "priority");
}

#[sqlx::test(migrations = "../../migrations")]
async fn duplicate_queue_name_is_rejected(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    app.queue(&admin, "email").await;
    let reply = app.post("/api/queues", &admin, json!({ "name": "email" })).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["error"]["details"]["fields"][0]["path"], "name");
}

#[sqlx::test(migrations = "../../migrations")]
async fn run_at_more_than_a_year_ahead_is_rejected(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    app.queue(&admin, "email").await;
    let too_late = t0() + Duration::days(366);
    let reply = app
        .post(
            "/api/jobs",
            &admin,
            json!({ "queue": "email", "kind": "k", "payload": {}, "run_at": too_late }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    let reply = app
        .post(
            "/api/jobs",
            &admin,
            json!({ "queue": "email", "kind": "k", "payload": {}, "delay_seconds": 30 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    assert_eq!(
        reply.body["run_at"],
        json!(t0() + Duration::seconds(30))
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn payload_over_the_limit_is_413(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    app.queue(&admin, "email").await;

    // A JSON string of n characters serializes to n + 2 bytes.
    let too_big = "a".repeat(65_535);
    let reply = app
        .post(
            "/api/jobs",
            &admin,
            json!({ "queue": "email", "kind": "k", "payload": too_big }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error_code(&reply), "payload_too_large");

    let just_fits = "a".repeat(65_534);
    let reply = app
        .post(
            "/api/jobs",
            &admin,
            json!({ "queue": "email", "kind": "k", "payload": just_fits }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
}

#[sqlx::test(migrations = "../../migrations")]
async fn unknown_queue_is_422(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    let reply = app
        .post(
            "/api/jobs",
            &admin,
            json!({ "queue": "nope", "kind": "k", "payload": {} }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_code(&reply), "unknown_queue");
}

#[sqlx::test(migrations = "../../migrations")]
async fn enqueue_with_a_held_unique_key_returns_200_and_the_same_job(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    app.queue(&admin, "email").await;
    let body = json!({ "queue": "email", "kind": "k", "payload": {}, "unique_key": "u1" });
    let first = app.post("/api/jobs", &admin, body.clone()).await;
    assert_eq!(first.status, StatusCode::CREATED);
    assert_eq!(first.body["deduplicated"], false);
    let second = app.post("/api/jobs", &admin, body).await;
    assert_eq!(second.status, StatusCode::OK);
    assert_eq!(second.body["deduplicated"], true);
    assert_eq!(second.body["id"], first.body["id"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn permission_matrix_per_role(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    app.queue(&admin, "email").await;

    let cases = [
        (Role::Viewer, &[][..]),
        (Role::Submitter, &["*"][..]),
        (Role::Operator, &[][..]),
        (Role::Admin, &[][..]),
    ];
    for (i, (role, queues)) in cases.iter().enumerate() {
        let t = token(&pool, *role, queues).await;
        let name = format!("q{i}");

        let reply = app.get("/api/queues", &t).await;
        assert_eq!(reply.status, StatusCode::OK, "{role:?} read");

        let reply = app.post("/api/queues", &t, json!({ "name": name })).await;
        let expected = if *role == Role::Admin {
            StatusCode::CREATED
        } else {
            StatusCode::FORBIDDEN
        };
        assert_eq!(reply.status, expected, "{role:?} create queue");

        let reply = app
            .post(
                "/api/jobs",
                &t,
                json!({ "queue": "email", "kind": "k", "payload": {} }),
            )
            .await;
        let expected = if *role == Role::Viewer {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::CREATED
        };
        assert_eq!(reply.status, expected, "{role:?} enqueue");

        let reply = app.post("/api/queues/email/pause", &t, json!({})).await;
        let expected = if matches!(role, Role::Operator | Role::Admin) {
            StatusCode::OK
        } else {
            StatusCode::FORBIDDEN
        };
        assert_eq!(reply.status, expected, "{role:?} pause");

        let reply = app
            .patch("/api/queues/email", &t, json!({ "max_concurrency": 3 }))
            .await;
        let expected = if *role == Role::Admin {
            StatusCode::OK
        } else {
            StatusCode::FORBIDDEN
        };
        assert_eq!(reply.status, expected, "{role:?} edit queue");

        let reply = app
            .post("/api/tokens", &t, json!({ "name": "x", "role": "viewer" }))
            .await;
        let expected = if *role == Role::Admin {
            StatusCode::CREATED
        } else {
            StatusCode::FORBIDDEN
        };
        assert_eq!(reply.status, expected, "{role:?} create token");
        if reply.status == StatusCode::FORBIDDEN {
            assert_eq!(error_code(&reply), "forbidden");
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn submitter_is_limited_to_its_queues(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    app.queue(&admin, "email").await;
    app.queue(&admin, "billing").await;
    let submitter = token(&pool, Role::Submitter, &["email"]).await;

    let own = app.job(&submitter, "email").await;
    let foreign = app.job(&admin, "billing").await;

    let reply = app
        .post(
            "/api/jobs",
            &submitter,
            json!({ "queue": "billing", "kind": "k", "payload": {} }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);

    let reply = app.get(&format!("/api/jobs/{own}"), &submitter).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(reply.body["attempts"].is_array());

    let reply = app.get(&format!("/api/jobs/{foreign}"), &submitter).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&reply), "not_found");

    let reply = app.get("/api/jobs", &submitter).await;
    let items = reply.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], own.as_str());

    let reply = app.get("/api/jobs?queue=billing", &submitter).await;
    assert_eq!(reply.body["items"].as_array().unwrap().len(), 0);

    let reply = app.get("/api/queues", &submitter).await;
    let names: Vec<&str> = reply.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|q| q["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["email"]);

    let reply = app.get("/api/queues/billing", &submitter).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[sqlx::test(migrations = "../../migrations")]
async fn job_listing_paginates_with_a_cursor(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    app.queue(&admin, "email").await;
    let mut ids = Vec::new();
    for _ in 0..3 {
        ids.push(app.job(&admin, "email").await);
        app.clock.advance(Duration::seconds(1));
    }

    let first = app.get("/api/jobs?limit=2", &admin).await;
    assert_eq!(first.status, StatusCode::OK);
    let items = first.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["id"], ids[2].as_str());
    assert_eq!(items[1]["id"], ids[1].as_str());
    let cursor = first.body["next_cursor"].as_str().unwrap().to_string();

    let second = app
        .get(&format!("/api/jobs?limit=2&after={cursor}"), &admin)
        .await;
    let items = second.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], ids[0].as_str());
    assert!(second.body["next_cursor"].is_null());

    for bad in ["/api/jobs?limit=0", "/api/jobs?limit=201", "/api/jobs?after=zz"] {
        let reply = app.get(bad, &admin).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(error_code(&reply), "validation_failed");
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn created_tokens_work_until_revoked(pool: PgPool) {
    let app = app(pool.clone());
    let admin = token(&pool, Role::Admin, &[]).await;
    let reply = app
        .post(
            "/api/tokens",
            &admin,
            json!({ "name": "ci", "role": "submitter", "queues": ["email"] }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let value = reply.body["token"].as_str().unwrap().to_string();
    let id = reply.body["id"].as_str().unwrap().to_string();
    assert!(reply.body.get("token_hash").is_none());

    assert_eq!(app.get("/api/queues", &value).await.status, StatusCode::OK);
    let revoked = app.delete(&format!("/api/tokens/{id}"), &admin).await;
    assert_eq!(revoked.status, StatusCode::OK);
    assert_eq!(
        app.get("/api/queues", &value).await.status,
        StatusCode::UNAUTHORIZED
    );

    let reply = app
        .post(
            "/api/tokens",
            &admin,
            json!({ "name": "bad", "role": "submitter", "queues": [] }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}
