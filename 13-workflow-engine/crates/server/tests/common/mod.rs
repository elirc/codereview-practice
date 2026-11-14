#![allow(dead_code)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use chrono::{DateTime, TimeZone, Utc};
use engine_core::authz::Role;
use engine_core::clock::FixedClock;
use engine_core::secrets::{RandomSecrets, SecretSource, SequentialSecrets};
use engine_store::tokens::{create_token, NewToken};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use wfe_server::{build_router, AppState};

pub fn t0() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 1, 5, 12, 0, 0).unwrap()
}

pub struct TestApp {
    pub router: Router,
    pub clock: Arc<FixedClock>,
    pub pool: PgPool,
}

pub fn app(pool: PgPool) -> TestApp {
    let clock = Arc::new(FixedClock::new(t0()));
    let state = AppState::new(pool.clone(), clock.clone(), Arc::new(SequentialSecrets::default()));
    TestApp {
        router: build_router(state),
        clock,
        pool,
    }
}

/// Creates a token directly in the database and returns its value.
pub async fn token(pool: &PgPool, role: Role, queues: &[&str]) -> String {
    let secret = RandomSecrets.token();
    let new = NewToken {
        name: format!("{} token", role.as_str()),
        role,
        queues: queues.iter().map(|q| q.to_string()).collect(),
    };
    create_token(pool, &new, &secret, t0()).await.unwrap();
    secret
}

pub struct Reply {
    pub status: StatusCode,
    pub body: Value,
    pub request_id: Option<String>,
}

impl TestApp {
    pub async fn send(
        &self,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
        request_id: Option<&str>,
    ) -> Reply {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        if let Some(id) = request_id {
            builder = builder.header("x-request-id", id);
        }
        let request = match body {
            Some(body) => builder
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let request_id = response
            .headers()
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        Reply {
            status,
            body,
            request_id,
        }
    }

    pub async fn get(&self, uri: &str, token: &str) -> Reply {
        self.send(Method::GET, uri, Some(token), None, None).await
    }

    pub async fn post(&self, uri: &str, token: &str, body: Value) -> Reply {
        self.send(Method::POST, uri, Some(token), Some(body), None)
            .await
    }

    pub async fn patch(&self, uri: &str, token: &str, body: Value) -> Reply {
        self.send(Method::PATCH, uri, Some(token), Some(body), None)
            .await
    }

    pub async fn delete(&self, uri: &str, token: &str) -> Reply {
        self.send(Method::DELETE, uri, Some(token), None, None).await
    }

    /// Creates a queue with default limits through the API.
    pub async fn queue(&self, admin: &str, name: &str) {
        let reply = self.post("/api/queues", admin, json!({ "name": name })).await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    }

    /// Enqueues a job through the API and returns its id.
    pub async fn job(&self, token: &str, queue: &str) -> String {
        let reply = self
            .post(
                "/api/jobs",
                token,
                json!({ "queue": queue, "kind": "email.send", "payload": {} }),
            )
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
        reply.body["id"].as_str().unwrap().to_string()
    }
}

pub fn error_code(reply: &Reply) -> &str {
    reply.body["error"]["code"].as_str().unwrap_or("")
}
