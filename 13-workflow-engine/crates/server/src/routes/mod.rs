use axum::body::Body;
use axum::http::Request;
use axum::middleware;
use axum::routing::{delete, get, post};
use axum::Router;
use tower_http::trace::{DefaultOnResponse, TraceLayer};
use tracing::{Level, Span};

use crate::auth;
use crate::error::ApiError;
use crate::request_id::{assign_request_id, RequestId};
use crate::state::AppState;

mod health;
mod jobs;
mod queues;
mod schedules;
mod tokens;

/// Builds the application router with every route and middleware.
pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/queues", get(queues::list).post(queues::create))
        .route("/queues/:name", get(queues::show).patch(queues::update))
        .route("/queues/:name/pause", post(queues::pause))
        .route("/queues/:name/resume", post(queues::resume))
        .route("/jobs", get(jobs::list).post(jobs::enqueue))
        .route("/jobs/:id", get(jobs::show))
        .route("/jobs/:id/cancel", post(jobs::cancel))
        .route("/jobs/:id/requeue", post(jobs::requeue))
        .route("/schedules", get(schedules::list).post(schedules::create))
        .route(
            "/schedules/:id",
            get(schedules::show)
                .patch(schedules::update)
                .delete(schedules::remove),
        )
        .route("/schedules/:id/pause", post(schedules::pause))
        .route("/schedules/:id/resume", post(schedules::resume))
        .route("/tokens", post(tokens::create))
        .route("/tokens/:id", delete(tokens::revoke))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ))
        .route("/healthz", get(health::healthz));

    Router::new()
        .nest("/api", api)
        .fallback(not_found)
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(make_span)
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        )
        .layer(middleware::from_fn(assign_request_id))
        .with_state(state)
}

fn make_span(req: &Request<Body>) -> Span {
    let request_id = req
        .extensions()
        .get::<RequestId>()
        .map(|r| r.0.clone())
        .unwrap_or_default();
    tracing::info_span!(
        "http_request",
        method = %req.method(),
        path = %req.uri().path(),
        request_id = %request_id,
    )
}

async fn not_found() -> ApiError {
    ApiError::NotFound
}
