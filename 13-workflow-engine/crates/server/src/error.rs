use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use engine_store::StoreError;
use serde::Serialize;
use serde_json::{json, Value};

use crate::request_id::current_request_id;

/// One invalid field in a request.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FieldError {
    pub path: String,
    pub message: String,
}

impl FieldError {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

/// Every error an API handler can return. Converted to the JSON error envelope.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("request validation failed")]
    Validation(Vec<FieldError>),
    #[error("authentication required")]
    Unauthenticated,
    #[error("forbidden")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("unknown queue {0}")]
    UnknownQueue(String),
    #[error("invalid cron expression")]
    InvalidCron(String),
    #[error("invalid workflow definition")]
    InvalidWorkflow(Value),
    #[error("{0}")]
    InvalidState(String),
    #[error("job belongs to a workflow run")]
    WorkflowJob,
    #[error("unique key conflict")]
    UniqueKeyConflict,
    #[error("{0} too large")]
    PayloadTooLarge(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl ApiError {
    /// Builds a validation error for a single field.
    pub fn field(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Validation(vec![FieldError::new(path, message)])
    }

    fn status(&self) -> StatusCode {
        match self {
            Self::Validation(_) => StatusCode::BAD_REQUEST,
            Self::Unauthenticated => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::UnknownQueue(_) | Self::InvalidCron(_) | Self::InvalidWorkflow(_) => {
                StatusCode::UNPROCESSABLE_ENTITY
            }
            Self::InvalidState(_) | Self::WorkflowJob | Self::UniqueKeyConflict => {
                StatusCode::CONFLICT
            }
            Self::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn code(&self) -> &'static str {
        match self {
            Self::Validation(_) => "validation_failed",
            Self::Unauthenticated => "unauthenticated",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::UnknownQueue(_) => "unknown_queue",
            Self::InvalidCron(_) => "invalid_cron",
            Self::InvalidWorkflow(_) => "invalid_workflow",
            Self::InvalidState(_) => "invalid_state",
            Self::WorkflowJob => "workflow_job",
            Self::UniqueKeyConflict => "unique_key_conflict",
            Self::PayloadTooLarge(_) => "payload_too_large",
            Self::Internal(_) => "internal_error",
        }
    }

    fn message_and_details(&self) -> (String, Value) {
        match self {
            Self::Validation(fields) => (
                "The request is invalid.".to_string(),
                json!({ "fields": fields }),
            ),
            Self::Unauthenticated => ("A valid API token is required.".to_string(), json!({})),
            Self::Forbidden => (
                "This token is not allowed to perform this action.".to_string(),
                json!({}),
            ),
            Self::NotFound => ("The resource was not found.".to_string(), json!({})),
            Self::UnknownQueue(queue) => (
                format!("Queue {queue} does not exist."),
                json!({ "queue": queue }),
            ),
            Self::InvalidCron(reason) => (
                "The cron expression is invalid.".to_string(),
                json!({ "reason": reason }),
            ),
            Self::InvalidWorkflow(problems) => (
                "The workflow definition is invalid.".to_string(),
                json!({ "problems": problems }),
            ),
            Self::InvalidState(message) => (message.clone(), json!({})),
            Self::WorkflowJob => (
                "The job belongs to a workflow run; act on the run instead.".to_string(),
                json!({}),
            ),
            Self::UniqueKeyConflict => (
                "Another live job holds the same unique key.".to_string(),
                json!({}),
            ),
            Self::PayloadTooLarge(what) => (
                format!("The {what} exceeds the size limit."),
                json!({}),
            ),
            Self::Internal(_) => ("An unexpected error occurred.".to_string(), json!({})),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if let Self::Internal(err) = &self {
            tracing::error!(error = ?err, "unexpected error while handling request");
        }
        let status = self.status();
        let code = self.code();
        let (message, details) = self.message_and_details();
        let body = json!({
            "error": {
                "code": code,
                "message": message,
                "details": details,
                "requestId": current_request_id(),
            }
        });
        (status, Json(body)).into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(err: StoreError) -> Self {
        match err {
            StoreError::NotFound => Self::NotFound,
            StoreError::UnknownQueue(queue) => Self::UnknownQueue(queue),
            StoreError::InvalidState(message) => Self::InvalidState(message),
            StoreError::Conflict { field, message } => Self::field(field, message),
            StoreError::WorkflowJob => Self::WorkflowJob,
            StoreError::UniqueKeyConflict => Self::UniqueKeyConflict,
            StoreError::LeaseLost => Self::InvalidState("The job's lease has changed.".to_string()),
            StoreError::InvalidCron(reason) => Self::InvalidCron(reason),
            StoreError::InvalidWorkflow(problems) => {
                Self::InvalidWorkflow(serde_json::to_value(problems).unwrap_or_default())
            }
            StoreError::Corrupt(message) => {
                Self::Internal(anyhow::anyhow!("inconsistent stored data: {message}"))
            }
            StoreError::Db(err) => Self::Internal(anyhow::Error::new(err)),
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        Self::Internal(anyhow::Error::new(err))
    }
}
