//! Background loops run by the server. Each loop body is a store function that tests call
//! directly; the wrappers here only wait, call and log.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use engine_core::clock::{Clock, JitterSource, SyncedClock};
use engine_store::{clock_sync, reaper, StoreError};
use sqlx::PgPool;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub const REAPER_INTERVAL: Duration = Duration::from_secs(5);
pub const CLOCK_SYNC_INTERVAL: Duration = Duration::from_secs(30);

/// The clock to keep aligned with the database, and the offset worth a warning.
#[derive(Clone)]
pub struct ClockSync {
    pub clock: Arc<SyncedClock>,
    pub warn_ms: i64,
}

/// Dependencies shared by the loops.
#[derive(Clone)]
pub struct LoopContext {
    pub pool: PgPool,
    pub clock: Arc<dyn Clock>,
    pub jitter: Arc<dyn JitterSource>,
    pub clock_sync: Option<ClockSync>,
}

/// Starts every server loop. They stop after their current pass once `shutdown` is cancelled.
pub fn spawn_all(ctx: LoopContext, shutdown: CancellationToken) -> Vec<JoinHandle<()>> {
    let mut handles = Vec::new();

    let reaper_ctx = ctx.clone();
    let reap = move || {
        let ctx = reaper_ctx.clone();
        async move {
            reaper::reap_expired(&ctx.pool, ctx.clock.now(), ctx.jitter.as_ref()).await
        }
    };
    handles.push(tokio::spawn(run_every("reaper", REAPER_INTERVAL, shutdown.clone(), reap)));

    if let Some(sync) = ctx.clock_sync.clone() {
        let pool = ctx.pool.clone();
        let resync = move || {
            let pool = pool.clone();
            let sync = sync.clone();
            async move {
                clock_sync::sync_clock(&pool, &sync.clock, sync.warn_ms)
                    .await
                    .map(|_| 0)
            }
        };
        handles.push(tokio::spawn(run_every(
            "clock_sync",
            CLOCK_SYNC_INTERVAL,
            shutdown.clone(),
            resync,
        )));
    }

    handles
}

/// Calls `body` every `interval` until `shutdown` is cancelled, logging what each pass did.
pub async fn run_every<F, Fut>(
    name: &'static str,
    interval: Duration,
    shutdown: CancellationToken,
    mut body: F,
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<usize, StoreError>>,
{
    tracing::info!(loop_name = name, "loop started");
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = tokio::time::sleep(interval) => {}
        }
        match body().await {
            Ok(0) => {}
            Ok(processed) => tracing::info!(loop_name = name, processed, "loop pass finished"),
            Err(err) => tracing::error!(loop_name = name, error = %err, "loop pass failed"),
        }
    }
    tracing::info!(loop_name = name, "loop stopped");
}
