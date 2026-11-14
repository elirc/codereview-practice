use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;
use uuid::Uuid;

static REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

tokio::task_local! {
    static REQUEST_ID: String;
}

/// Request id attached to the request's extensions.
#[derive(Debug, Clone)]
pub struct RequestId(pub String);

/// Returns the id of the request being handled on this task, or an empty string.
pub fn current_request_id() -> String {
    REQUEST_ID.try_with(|id| id.clone()).unwrap_or_default()
}

fn is_acceptable(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Middleware that adopts the inbound `X-Request-Id` or generates one, makes it available to
/// the rest of the request, and echoes it on the response.
pub async fn assign_request_id(mut req: Request, next: Next) -> Response {
    let id = req
        .headers()
        .get(&REQUEST_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|v| is_acceptable(v))
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    req.extensions_mut().insert(RequestId(id.clone()));
    let mut response = REQUEST_ID.scope(id.clone(), next.run(req)).await;
    if let Ok(value) = HeaderValue::from_str(&id) {
        response
            .headers_mut()
            .insert(REQUEST_ID_HEADER.clone(), value);
    }
    response
}
