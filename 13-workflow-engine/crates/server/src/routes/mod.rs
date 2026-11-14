use axum::body::Body;
use axum::http::Request;
use axum::middleware;
use axum::routing::get;
use axum::Router;
use tower_http::trace::{DefaultOnResponse, TraceLayer};
use tracing::{Level, Span};

use crate::error::ApiError;
use crate::request_id::{assign_request_id, RequestId};
use crate::state::AppState;

mod health;

/// Builds the application router with every route and middleware.
pub fn build_router(state: AppState) -> Router {
    let api = Router::new().route("/healthz", get(health::healthz));

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
