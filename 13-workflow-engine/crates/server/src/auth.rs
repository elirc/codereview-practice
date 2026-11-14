use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::Response;
use engine_core::authz::{Action, Caller, Role};
use engine_store::tokens;

use crate::error::ApiError;
use crate::state::AppState;

/// Middleware that resolves the bearer token to a [`Caller`] and stores it in the request
/// extensions.
pub async fn require_token(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let secret = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or(ApiError::Unauthenticated)?
        .to_string();
    let token = tokens::find_active_token(&state.pool, &secret)
        .await?
        .ok_or(ApiError::Unauthenticated)?;
    let role: Role = token
        .role
        .parse()
        .map_err(|e| ApiError::Internal(anyhow::Error::new(e)))?;
    req.extensions_mut().insert(Caller {
        token_id: token.id,
        role,
        queues: token.queues,
    });
    Ok(next.run(req).await)
}

/// Fails with `403 forbidden` unless the caller's role permits `action`.
pub fn ensure(caller: &Caller, action: Action) -> Result<(), ApiError> {
    if caller.may(action) {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

/// Fails with `404 not_found` unless the caller may see `queue`.
pub fn ensure_visible(caller: &Caller, queue: &str) -> Result<(), ApiError> {
    if caller.may_use_queue(queue) {
        Ok(())
    } else {
        Err(ApiError::NotFound)
    }
}

/// Fails with `403 forbidden` unless the caller may submit work to `queue`.
pub fn ensure_usable(caller: &Caller, queue: &str) -> Result<(), ApiError> {
    if caller.may_use_queue(queue) {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}
