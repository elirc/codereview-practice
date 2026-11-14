use std::net::SocketAddr;

use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use wfe_worker::handlers::{
    Handler, HandlerError, HttpHandler, JobContext, MAX_RESPONSE_BODY_BYTES,
};

async fn start_server() -> SocketAddr {
    let app = Router::new()
        .route("/ok", get(|| async { "hello" }))
        .route(
            "/status/:code",
            get(|Path(code): Path<u16>| async move {
                (StatusCode::from_u16(code).unwrap(), "status body")
            }),
        )
        .route(
            "/key",
            get(|headers: HeaderMap| async move {
                headers
                    .get("idempotency-key")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string()
            }),
        )
        .route("/echo", post(|Json(body): Json<Value>| async move { Json(body) }))
        .route("/big", get(|| async { "b".repeat(100_000) }))
        .route("/hang", get(|| std::future::pending::<String>()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

fn context(payload: Value) -> (JobContext, Uuid) {
    let id = Uuid::new_v4();
    let ctx = JobContext {
        job_id: id,
        idempotency_key: id.to_string(),
        queue: "work".to_string(),
        kind: "http".to_string(),
        attempt: 1,
        payload,
        workflow_run_id: None,
        step_key: None,
        cancel: CancellationToken::new(),
    };
    (ctx, id)
}

async fn call(payload: Value) -> Result<Value, HandlerError> {
    let handler = HttpHandler::new(reqwest::Client::new());
    let (ctx, _) = context(payload);
    handler.run(ctx).await
}

#[tokio::test]
async fn success_returns_status_and_body() {
    let addr = start_server().await;
    let result = call(json!({ "method": "GET", "url": format!("http://{addr}/ok") }))
        .await
        .unwrap();
    assert_eq!(result, json!({ "status": 200, "body": "hello" }));
}

#[tokio::test]
async fn json_body_is_sent() {
    let addr = start_server().await;
    let result = call(json!({
        "method": "post",
        "url": format!("http://{addr}/echo"),
        "body": { "a": 1 },
    }))
    .await
    .unwrap();
    assert_eq!(result["status"], 200);
    assert_eq!(result["body"], "{\"a\":1}");
}

#[tokio::test]
async fn server_errors_timeouts_and_throttling_are_retryable() {
    let addr = start_server().await;
    for code in [500, 503, 408, 429] {
        let result = call(json!({
            "method": "GET",
            "url": format!("http://{addr}/status/{code}"),
        }))
        .await;
        assert!(
            matches!(result, Err(HandlerError::Retryable(_))),
            "status {code}: {result:?}"
        );
    }
}

#[tokio::test]
async fn other_client_errors_are_permanent() {
    let addr = start_server().await;
    for code in [400, 401, 404, 422] {
        let result = call(json!({
            "method": "GET",
            "url": format!("http://{addr}/status/{code}"),
        }))
        .await;
        assert!(
            matches!(result, Err(HandlerError::Permanent(_))),
            "status {code}: {result:?}"
        );
    }
}

#[tokio::test]
async fn connection_refused_is_retryable() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let result = call(json!({ "method": "GET", "url": format!("http://{addr}/ok") })).await;
    assert!(matches!(result, Err(HandlerError::Retryable(_))), "{result:?}");
}

#[tokio::test]
async fn timeout_is_retryable() {
    let addr = start_server().await;
    let result = call(json!({
        "method": "GET",
        "url": format!("http://{addr}/hang"),
        "timeout_ms": 50,
    }))
    .await;
    assert!(matches!(result, Err(HandlerError::Retryable(_))), "{result:?}");
}

#[tokio::test]
async fn idempotency_key_is_the_job_id() {
    let addr = start_server().await;
    let handler = HttpHandler::new(reqwest::Client::new());
    let (ctx, id) = context(json!({ "method": "GET", "url": format!("http://{addr}/key") }));
    let result = handler.run(ctx).await.unwrap();
    assert_eq!(result["body"], id.to_string());
}

#[tokio::test]
async fn long_bodies_are_cut() {
    let addr = start_server().await;
    let result = call(json!({ "method": "GET", "url": format!("http://{addr}/big") }))
        .await
        .unwrap();
    assert_eq!(
        result["body"].as_str().unwrap().len(),
        MAX_RESPONSE_BODY_BYTES
    );
}

#[tokio::test]
async fn cancellation_stops_the_request() {
    let addr = start_server().await;
    let handler = HttpHandler::new(reqwest::Client::new());
    let (ctx, _) = context(json!({ "method": "GET", "url": format!("http://{addr}/hang") }));
    ctx.cancel.cancel();
    assert_eq!(handler.run(ctx).await, Err(HandlerError::Cancelled));
}

#[tokio::test]
async fn invalid_payloads_are_permanent() {
    let result = call(json!({ "url": "http://127.0.0.1:1/" })).await;
    assert!(matches!(result, Err(HandlerError::Permanent(_))));
    let result = call(json!({ "method": "GET", "url": "not a url" })).await;
    assert!(matches!(result, Err(HandlerError::Permanent(_))), "{result:?}");
}
