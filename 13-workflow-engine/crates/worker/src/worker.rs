//! The claim loop: polls the configured queues and runs claimed jobs on spawned tasks.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::runner::{run_job, RunOutcome, RunnerEnv};

/// Settings for the claim loop.
#[derive(Debug, Clone)]
pub struct WorkerSettings {
    pub queues: Vec<String>,
    pub concurrency: usize,
    pub poll_interval: Duration,
}

/// A worker process's claim loop.
pub struct Worker {
    env: Arc<RunnerEnv>,
    settings: WorkerSettings,
}

impl Worker {
    pub fn new(env: Arc<RunnerEnv>, settings: WorkerSettings) -> Self {
        Self { env, settings }
    }

    /// Claims and runs jobs until `shutdown` is cancelled, then waits for running jobs.
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
        tracing::info!(running = tasks.len(), "claiming stopped");
        while tasks.join_next().await.is_some() {}
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
            let now = self.env.clock.now();
            let limit = i64::try_from(free).unwrap_or(i64::MAX);
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
                let env = self.env.clone();
                let cancel = CancellationToken::new();
                tasks.spawn(async move {
                    let outcome = run_job(env, job, cancel).await;
                    drop(permit);
                    outcome
                });
            }
        }
        claimed
    }
}
