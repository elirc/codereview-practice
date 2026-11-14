//! Job handlers and the registry that maps job kinds to them.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

mod builtin;
mod http;

pub use builtin::{FailHandler, MergeHandler, NoopHandler, SleepHandler};
pub use http::{classify_status, HttpHandler, MAX_RESPONSE_BODY_BYTES};

/// Everything a handler receives about the job it runs.
#[derive(Debug, Clone)]
pub struct JobContext {
    pub job_id: Uuid,
    /// Stable across attempts of the same job; pass it to external services.
    pub idempotency_key: String,
    pub queue: String,
    pub kind: String,
    pub attempt: i32,
    pub payload: Value,
    pub workflow_run_id: Option<Uuid>,
    pub step_key: Option<String>,
    /// Fires when the job should stop.
    pub cancel: CancellationToken,
}

/// Error returned by a handler.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HandlerError {
    #[error("{0}")]
    Retryable(String),
    #[error("{0}")]
    Permanent(String),
    #[error("cancelled")]
    Cancelled,
}

/// Code that runs jobs of one kind.
#[async_trait]
pub trait Handler: Send + Sync + 'static {
    /// Runs one attempt of a job and returns its result.
    async fn run(&self, ctx: JobContext) -> Result<Value, HandlerError>;
}

/// Handlers registered by job kind.
#[derive(Clone, Default)]
pub struct Registry {
    handlers: HashMap<String, Arc<dyn Handler>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `handler` for `kind`, replacing any earlier registration.
    pub fn register(&mut self, kind: &str, handler: Arc<dyn Handler>) {
        self.handlers.insert(kind.to_string(), handler);
    }

    /// Returns the handler for `kind`.
    pub fn get(&self, kind: &str) -> Option<Arc<dyn Handler>> {
        self.handlers.get(kind).cloned()
    }

    /// Returns the registered kinds in sorted order.
    pub fn kinds(&self) -> Vec<String> {
        let mut kinds: Vec<String> = self.handlers.keys().cloned().collect();
        kinds.sort();
        kinds
    }
}

/// Returns a registry with the built-in `noop`, `sleep`, `fail`, `http` and `merge` handlers.
pub fn builtin_registry(client: reqwest::Client) -> Registry {
    let mut registry = Registry::new();
    registry.register("noop", Arc::new(NoopHandler));
    registry.register("sleep", Arc::new(SleepHandler));
    registry.register("fail", Arc::new(FailHandler));
    registry.register("http", Arc::new(HttpHandler::new(client)));
    registry.register("merge", Arc::new(MergeHandler));
    registry
}
