//! Running one claimed job: the handler task, its heartbeats and the final report.

use std::sync::Arc;
use std::time::Duration;

use engine_core::clock::Clock;
use engine_core::outcome::{FailureKind, HANDLER_PANICKED};
use engine_core::state::JobState;
use engine_store::claim::{ClaimRef, ClaimedJob};
use engine_store::lease::Completion;
use engine_store::StoreError;
use serde_json::Value;
use tokio::task::{JoinError, JoinHandle};
use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use tracing::Instrument;

use crate::handlers::{HandlerError, JobContext, Registry};
use crate::store::WorkerStore;

/// What a job runner needs from its worker.
pub struct RunnerEnv {
    pub store: Arc<dyn WorkerStore>,
    pub clock: Arc<dyn Clock>,
    pub registry: Registry,
    pub worker_id: String,
}

/// How a run ended from the worker's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    /// The outcome was recorded and the job moved to this state.
    Reported(JobState),
    /// The worker stopped the handler and wrote nothing for the claim.
    Abandoned,
    /// The handler finished but its outcome could not be recorded.
    NotReported,
}

enum Report {
    Complete(Value),
    Fail(FailureKind, String),
}

type Joined = Result<Result<Value, HandlerError>, JoinError>;

/// Aborts the wrapped task when dropped.
struct AbortOnDrop<T>(JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Returns the interval between heartbeats for a lease of `lease_seconds`.
pub fn heartbeat_period(lease_seconds: i32) -> Duration {
    let lease_ms = u64::try_from(lease_seconds.max(1)).unwrap_or(1) * 1000;
    Duration::from_millis(lease_ms / 3)
}

/// Runs a claimed job to completion and records its outcome. `cancel` is handed to the
/// handler and fires when cancellation is requested or the run is stopped.
pub async fn run_job(env: Arc<RunnerEnv>, job: ClaimedJob, cancel: CancellationToken) -> RunOutcome {
    let span = tracing::info_span!(
        "job",
        job_id = %job.id,
        attempt = job.attempt,
        worker_id = %env.worker_id,
        kind = %job.kind,
    );
    execute(env, job, cancel).instrument(span).await
}

async fn execute(env: Arc<RunnerEnv>, job: ClaimedJob, cancel: CancellationToken) -> RunOutcome {
    tracing::info!(queue = %job.queue, "job started");
    let claim = job.claim_ref();
    let report = match env.registry.get(&job.kind) {
        None => Report::Fail(
            FailureKind::Permanent,
            format!("no handler registered for kind {}", job.kind),
        ),
        Some(handler) => {
            let ctx = JobContext {
                job_id: job.id,
                idempotency_key: job.id.to_string(),
                queue: job.queue.clone(),
                kind: job.kind.clone(),
                attempt: job.attempt,
                payload: job.payload.clone(),
                workflow_run_id: job.workflow_run_id,
                step_key: job.step_key.clone(),
                cancel: cancel.clone(),
            };
            let mut task = AbortOnDrop(tokio::spawn(async move { handler.run(ctx).await }));
            match supervise(&env, &claim, job.lease_seconds, &mut task, &cancel).await {
                Some(joined) => report_for(joined),
                None => return RunOutcome::Abandoned,
            }
        }
    };
    report_outcome(&env, &claim, report).await
}

/// Waits for the handler while sending heartbeats. Returns `None` when the claim is given up.
async fn supervise(
    env: &RunnerEnv,
    claim: &ClaimRef,
    lease_seconds: i32,
    task: &mut AbortOnDrop<Result<Value, HandlerError>>,
    cancel: &CancellationToken,
) -> Option<Joined> {
    let period = heartbeat_period(lease_seconds);
    let mut ticker = tokio::time::interval_at(Instant::now() + period, period);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            joined = &mut task.0 => return Some(joined),
            _ = ticker.tick() => {
                match env.store.heartbeat(claim, env.clock.now()).await {
                    Ok(true) => {
                        if !cancel.is_cancelled() {
                            tracing::info!("cancellation requested");
                            cancel.cancel();
                        }
                    }
                    Ok(false) => {}
                    Err(StoreError::LeaseLost) => {
                        tracing::warn!("claim no longer held; handler stopped");
                        cancel.cancel();
                        task.0.abort();
                        return None;
                    }
                    Err(err) => tracing::warn!(error = %err, "heartbeat failed"),
                }
            }
        }
    }
}

fn report_for(joined: Joined) -> Report {
    match joined {
        Ok(Ok(value)) => Report::Complete(value),
        Ok(Err(HandlerError::Retryable(message))) => Report::Fail(FailureKind::Retryable, message),
        Ok(Err(HandlerError::Permanent(message))) => Report::Fail(FailureKind::Permanent, message),
        Ok(Err(HandlerError::Cancelled)) => {
            Report::Fail(FailureKind::Cancelled, "cancelled".to_string())
        }
        Err(err) if err.is_panic() => {
            Report::Fail(FailureKind::Retryable, HANDLER_PANICKED.to_string())
        }
        Err(_) => Report::Fail(FailureKind::Retryable, "handler task stopped".to_string()),
    }
}

async fn write_report(
    env: &RunnerEnv,
    claim: &ClaimRef,
    report: &Report,
) -> Result<JobState, StoreError> {
    let now = env.clock.now();
    match report {
        Report::Complete(value) => match env.store.complete(claim, value, now).await? {
            Completion::Succeeded => Ok(JobState::Succeeded),
            Completion::ResultTooLarge => Ok(JobState::Dead),
        },
        Report::Fail(kind, message) => env.store.fail(claim, *kind, message, now).await,
    }
}

async fn report_outcome(env: &RunnerEnv, claim: &ClaimRef, report: Report) -> RunOutcome {
    if let Report::Fail(kind, message) = &report {
        tracing::warn!(failure = ?kind, error = %message, "job failed");
    }
    match write_report(env, claim, &report).await {
        Ok(state) => {
            tracing::info!(state = state.as_str(), "job finished");
            RunOutcome::Reported(state)
        }
        Err(StoreError::LeaseLost) => {
            tracing::warn!("claim no longer held; outcome discarded");
            RunOutcome::NotReported
        }
        Err(err) => {
            tracing::error!(error = %err, "could not record job outcome");
            RunOutcome::NotReported
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_is_a_third_of_the_lease() {
        assert_eq!(heartbeat_period(60), Duration::from_secs(20));
        assert_eq!(heartbeat_period(5), Duration::from_millis(1666));
    }
}
