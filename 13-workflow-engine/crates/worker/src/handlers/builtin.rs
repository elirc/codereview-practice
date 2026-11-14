use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{Handler, HandlerError, JobContext};

fn parse<T: for<'de> Deserialize<'de>>(payload: &Value, kind: &str) -> Result<T, HandlerError> {
    serde_json::from_value(payload.clone())
        .map_err(|e| HandlerError::Permanent(format!("invalid {kind} payload: {e}")))
}

/// Returns its payload unchanged.
pub struct NoopHandler;

#[async_trait]
impl Handler for NoopHandler {
    async fn run(&self, ctx: JobContext) -> Result<Value, HandlerError> {
        Ok(ctx.payload)
    }
}

#[derive(Debug, Deserialize)]
struct SleepPayload {
    ms: u64,
}

/// Waits `payload.ms` milliseconds, stopping early with `Cancelled` when asked to.
pub struct SleepHandler;

#[async_trait]
impl Handler for SleepHandler {
    async fn run(&self, ctx: JobContext) -> Result<Value, HandlerError> {
        let payload: SleepPayload = parse(&ctx.payload, "sleep")?;
        tokio::select! {
            _ = ctx.cancel.cancelled() => Err(HandlerError::Cancelled),
            _ = tokio::time::sleep(Duration::from_millis(payload.ms)) => {
                Ok(json!({ "slept_ms": payload.ms }))
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FailMode {
    Retryable,
    Permanent,
}

#[derive(Debug, Deserialize)]
struct FailPayload {
    mode: FailMode,
    succeed_on_attempt: Option<i32>,
}

/// Fails as `payload.mode` says (`retryable` or `permanent`) until the attempt
/// number reaches `payload.succeed_on_attempt`, then succeeds.
pub struct FailHandler;

#[async_trait]
impl Handler for FailHandler {
    async fn run(&self, ctx: JobContext) -> Result<Value, HandlerError> {
        let payload: FailPayload = parse(&ctx.payload, "fail")?;
        if let Some(n) = payload.succeed_on_attempt {
            if ctx.attempt >= n {
                return Ok(json!({ "attempt": ctx.attempt }));
            }
        }
        match payload.mode {
            FailMode::Retryable => Err(HandlerError::Retryable(format!(
                "failed on attempt {}",
                ctx.attempt
            ))),
            FailMode::Permanent => Err(HandlerError::Permanent(format!(
                "failed permanently on attempt {}",
                ctx.attempt
            ))),
        }
    }
}

/// Returns `payload.parents`: the outputs of a workflow step's dependencies.
pub struct MergeHandler;

#[async_trait]
impl Handler for MergeHandler {
    async fn run(&self, ctx: JobContext) -> Result<Value, HandlerError> {
        Ok(ctx
            .payload
            .get("parents")
            .cloned()
            .unwrap_or_else(|| json!({})))
    }
}
