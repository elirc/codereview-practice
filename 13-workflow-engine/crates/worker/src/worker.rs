//! The claim loop: polls the configured queues, runs claimed jobs on spawned tasks and shuts
//! down in stages.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use engine_store::claim::ClaimRef;
use engine_store::StoreError;
use tokio::sync::Semaphore;
use tokio::task::{JoinError, JoinSet};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::runner::{run_claimed, ClaimContext, RunOutcome, RunnerEnv};

/// How long running handlers get after their tokens are cancelled at shutdown.
pub const CANCEL_WAIT: Duration = Duration::from_secs(5);

/// Settings for the claim loop.
#[derive(Debug, Clone)]
pub struct WorkerSettings {
    pub queues: Vec<String>,
    pub concurrency: usize,
    pub poll_interval: Duration,
    pub shutdown_grace: Duration,
}

type Held = Arc<Mutex<HashMap<Uuid, ClaimRef>>>;

/// What became of the jobs that were running when the worker began to stop.
#[derive(Debug, Default)]
struct DrainSummary {
    reported: usize,
    stopped: usize,
    unreported: usize,
    released: usize,
}

impl DrainSummary {
    fn record(&mut self, joined: Result<RunOutcome, JoinError>) {
        match joined {
            Ok(RunOutcome::Reported(_)) => self.reported += 1,
            Ok(RunOutcome::Stopped) => self.stopped += 1,
            Ok(RunOutcome::Abandoned | RunOutcome::NotReported) | Err(_) => self.unreported += 1,
        }
    }
}

fn lock(held: &Held) -> MutexGuard<'_, HashMap<Uuid, ClaimRef>> {
    held.lock().unwrap_or_else(|p| p.into_inner())
}

/// A worker process's claim loop.
pub struct Worker {
    env: Arc<RunnerEnv>,
    settings: WorkerSettings,
    held: Held,
    hard_stop: CancellationToken,
}

impl Worker {
    pub fn new(env: Arc<RunnerEnv>, settings: WorkerSettings) -> Self {
        Self {
            env,
            settings,
            held: Arc::new(Mutex::new(HashMap::new())),
            hard_stop: CancellationToken::new(),
        }
    }

    /// Claims and runs jobs until `shutdown` is cancelled, then stops: running jobs get the
    /// grace period to finish, then their tokens are cancelled, and after at most a further
    /// [`CANCEL_WAIT`] the claims still held are released.
    pub async fn run(self, shutdown: CancellationToken) {
        let slots = Arc::new(Semaphore::new(self.settings.concurrency));
        let mut tasks: JoinSet<RunOutcome> = JoinSet::new();
        let mut rotation = 0_usize;
        tracing::info!(
            worker_id = %self.env.worker_id,
            queues = ?self.settings.queues,
            concurrency = self.settings.concurrency,
            "worker started"
        );
        while !shutdown.is_cancelled() {
            while tasks.try_join_next().is_some() {}
            let claimed = self.poll_once(&slots, &mut tasks, rotation).await;
            rotation = rotation.wrapping_add(1);
            if claimed == 0 {
                tokio::select! {
                    _ = shutdown.cancelled() => break,
                    _ = tokio::time::sleep(self.settings.poll_interval) => {}
                }
            }
        }
        self.drain(tasks).await;
        tracing::info!("worker stopped");
    }

    /// Claims from each queue in turn, starting at `rotation`, for as many jobs as there are
    /// free slots, and spawns a task per claimed job. Returns how many jobs were claimed.
    pub async fn poll_once(
        &self,
        slots: &Arc<Semaphore>,
        tasks: &mut JoinSet<RunOutcome>,
        rotation: usize,
    ) -> usize {
        let kinds = self.env.registry.kinds();
        let queues = &self.settings.queues;
        let mut claimed = 0;
        for offset in 0..queues.len() {
            let free = slots.available_permits();
            if free == 0 {
                break;
            }
            let queue = &queues[(rotation + offset) % queues.len()];
            let limit = i64::try_from(free).unwrap_or(i64::MAX);
            let claimed_at = Instant::now();
            let now = self.env.clock.now();
            let jobs = match self
                .env
                .store
                .claim(queue, &kinds, &self.env.worker_id, limit, now)
                .await
            {
                Ok(jobs) => jobs,
                Err(err) => {
                    tracing::error!(queue = %queue, error = %err, "claim failed");
                    continue;
                }
            };
            for job in jobs {
                let permit = match slots.clone().acquire_owned().await {
                    Ok(permit) => permit,
                    Err(_) => break,
                };
                claimed += 1;
                let job_id = job.id;
                lock(&self.held).insert(job_id, job.claim_ref());
                let env = self.env.clone();
                let held = self.held.clone();
                let cancel = self.hard_stop.child_token();
                let claim_ctx = ClaimContext {
                    claimed_at,
                    worker_stop: self.hard_stop.clone(),
                };
                tasks.spawn(async move {
                    let outcome = run_claimed(env, job, cancel, claim_ctx).await;
                    if outcome != RunOutcome::Stopped {
                        lock(&held).remove(&job_id);
                    }
                    drop(permit);
                    outcome
                });
            }
        }
        claimed
    }

    async fn drain(&self, mut tasks: JoinSet<RunOutcome>) {
        tracing::info!(running = tasks.len(), "claiming stopped");
        let mut summary = DrainSummary::default();
        let grace = self.settings.shutdown_grace;
        let finished = tokio::time::timeout(grace, join_all(&mut tasks, &mut summary))
            .await
            .is_ok();
        if !finished {
            tracing::warn!(running = tasks.len(), "grace period over; cancelling running jobs");
            self.hard_stop.cancel();
            if tokio::time::timeout(CANCEL_WAIT, join_all(&mut tasks, &mut summary))
                .await
                .is_err()
            {
                tracing::warn!(running = tasks.len(), "jobs did not stop; releasing their claims");
                tasks.abort_all();
                join_all(&mut tasks, &mut summary).await;
            }
        }
        let remaining: Vec<ClaimRef> = lock(&self.held).drain().map(|(_, c)| c).collect();
        for claim in remaining {
            if self.release(&claim).await {
                summary.released += 1;
            }
        }
        tracing::info!(
            reported = summary.reported,
            stopped = summary.stopped,
            unreported = summary.unreported,
            released = summary.released,
            "running jobs drained"
        );
    }

    /// Releases a claim and returns whether it was released.
    async fn release(&self, claim: &ClaimRef) -> bool {
        match self.env.store.release(claim, self.env.clock.now()).await {
            Ok(state) => {
                tracing::info!(
                    job_id = %claim.job_id,
                    state = state.as_str(),
                    "claim released"
                );
                true
            }
            Err(StoreError::LeaseLost) => {
                tracing::warn!(job_id = %claim.job_id, "claim no longer held; not released");
                false
            }
            Err(err) => {
                tracing::error!(job_id = %claim.job_id, error = %err, "could not release claim");
                false
            }
        }
    }
}

async fn join_all(tasks: &mut JoinSet<RunOutcome>, summary: &mut DrainSummary) {
    while let Some(joined) = tasks.join_next().await {
        summary.record(joined);
    }
}
