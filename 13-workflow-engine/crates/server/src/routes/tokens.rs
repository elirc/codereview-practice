use axum::extract::State;
use axum::http::StatusCode;
use axum::{Extension, Json};
use engine_core::authz::{Action, Caller, Role, ALL_QUEUES};
use engine_core::names::is_queue_name;
use engine_store::models::ApiToken;
use engine_store::tokens::{self, NewToken};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::ensure;
use crate::error::ApiError;
use crate::extract::{ApiJson, ApiPath};
use crate::state::AppState;
use crate::validate::Problems;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateTokenBody {
    name: String,
    role: Role,
    #[serde(default)]
    queues: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CreatedToken {
    #[serde(flatten)]
    info: ApiToken,
    token: String,
}

/// `POST /api/tokens`: creates a token and returns its value, which is not shown again.
pub async fn create(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiJson(body): ApiJson<CreateTokenBody>,
) -> Result<(StatusCode, Json<CreatedToken>), ApiError> {
    ensure(&caller, Action::ManageTokens)?;
    let mut problems = Problems::new();
    let name_len = body.name.trim().chars().count();
    problems.check(
        (1..=100).contains(&name_len),
        "name",
        "must be 1 to 100 characters",
    );
    if body.role == Role::Submitter {
        problems.check(
            !body.queues.is_empty(),
            "queues",
            "a submitter token needs at least one queue",
        );
        problems.check(
            body.queues
                .iter()
                .all(|q| q == ALL_QUEUES || is_queue_name(q)),
            "queues",
            "each entry must be a queue name or *",
        );
    } else {
        problems.check(
            body.queues.is_empty(),
            "queues",
            "only submitter tokens are limited to queues",
        );
    }
    problems.finish()?;

    let secret = state.secrets.token();
    let new = NewToken {
        name: body.name.trim().to_string(),
        role: body.role,
        queues: body.queues,
    };
    let info = tokens::create_token(&state.pool, &new, &secret, state.clock.now()).await?;
    tracing::info!(token_id = %info.id, role = %new.role, "api token created");
    Ok((
        StatusCode::CREATED,
        Json(CreatedToken {
            info,
            token: secret,
        }),
    ))
}

/// `DELETE /api/tokens/{id}`: revokes a token.
pub async fn revoke(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    ApiPath(id): ApiPath<Uuid>,
) -> Result<Json<ApiToken>, ApiError> {
    ensure(&caller, Action::ManageTokens)?;
    let token = tokens::revoke_token(&state.pool, id, state.clock.now()).await?;
    tracing::info!(token_id = %token.id, "api token revoked");
    Ok(Json(token))
}
