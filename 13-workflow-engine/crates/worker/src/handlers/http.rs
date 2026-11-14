use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Method, RequestBuilder, Response};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{Handler, HandlerError, JobContext};

/// Longest response body returned in the result, in bytes.
pub const MAX_RESPONSE_BODY_BYTES: usize = 65_536;

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MAX_TIMEOUT_MS: u64 = 300_000;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HttpPayload {
    method: String,
    url: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<Value>,
    timeout_ms: Option<u64>,
}

/// Sends an HTTP request described by the payload and returns `{ status, body }`.
pub struct HttpHandler {
    client: reqwest::Client,
}

impl HttpHandler {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

/// Returns the error for a response status, or `None` when the status is a success.
///
/// `5xx`, `408` and `429` are retryable; other `4xx` are permanent.
pub fn classify_status(status: u16) -> Option<HandlerError> {
    if status == 408 || status == 429 || (500..=599).contains(&status) {
        Some(HandlerError::Retryable(format!("HTTP {status}")))
    } else if (400..=499).contains(&status) {
        Some(HandlerError::Permanent(format!("HTTP {status}")))
    } else {
        None
    }
}

fn classify_send_error(err: &reqwest::Error) -> HandlerError {
    if err.is_builder() {
        HandlerError::Permanent(format!("invalid request: {err}"))
    } else {
        HandlerError::Retryable(format!("request failed: {err}"))
    }
}

async fn read_capped(response: &mut Response) -> Result<Vec<u8>, HandlerError> {
    let mut body = Vec::new();
    while body.len() < MAX_RESPONSE_BODY_BYTES {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let room = MAX_RESPONSE_BODY_BYTES - body.len();
                let take = chunk.len().min(room);
                body.extend_from_slice(&chunk[..take]);
            }
            Ok(None) => break,
            Err(err) => {
                return Err(HandlerError::Retryable(format!(
                    "reading response failed: {err}"
                )))
            }
        }
    }
    Ok(body)
}

async fn execute(request: RequestBuilder) -> Result<Value, HandlerError> {
    let mut response = request.send().await.map_err(|e| classify_send_error(&e))?;
    let status = response.status().as_u16();
    let body = read_capped(&mut response).await?;
    if let Some(err) = classify_status(status) {
        return Err(err);
    }
    Ok(json!({
        "status": status,
        "body": String::from_utf8_lossy(&body),
    }))
}

#[async_trait]
impl Handler for HttpHandler {
    async fn run(&self, ctx: JobContext) -> Result<Value, HandlerError> {
        let payload: HttpPayload = serde_json::from_value(ctx.payload.clone())
            .map_err(|e| HandlerError::Permanent(format!("invalid http payload: {e}")))?;
        let method = Method::from_bytes(payload.method.to_ascii_uppercase().as_bytes())
            .map_err(|_| HandlerError::Permanent(format!("invalid method {}", payload.method)))?;
        let timeout = payload
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, MAX_TIMEOUT_MS);

        let mut request = self
            .client
            .request(method, payload.url.as_str())
            .timeout(Duration::from_millis(timeout))
            .header("Idempotency-Key", ctx.idempotency_key.as_str());
        for (name, value) in &payload.headers {
            request = request.header(name.as_str(), value.as_str());
        }
        if let Some(body) = &payload.body {
            request = request.json(body);
        }

        tokio::select! {
            _ = ctx.cancel.cancelled() => Err(HandlerError::Cancelled),
            result = execute(request) => result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_classification() {
        assert_eq!(classify_status(200), None);
        assert_eq!(classify_status(204), None);
        assert_eq!(classify_status(302), None);
        assert!(matches!(classify_status(500), Some(HandlerError::Retryable(_))));
        assert!(matches!(classify_status(503), Some(HandlerError::Retryable(_))));
        assert!(matches!(classify_status(408), Some(HandlerError::Retryable(_))));
        assert!(matches!(classify_status(429), Some(HandlerError::Retryable(_))));
        assert!(matches!(classify_status(400), Some(HandlerError::Permanent(_))));
        assert!(matches!(classify_status(404), Some(HandlerError::Permanent(_))));
        assert!(matches!(classify_status(422), Some(HandlerError::Permanent(_))));
    }
}
