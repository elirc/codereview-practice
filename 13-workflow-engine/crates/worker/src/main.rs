use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use engine_core::clock::{Clock, RandomJitter, SyncedClock, SystemClock};
use engine_store::clock_sync::sync_clock;
use sqlx::PgPool;
use tokio_util::sync::CancellationToken;
use wfe_worker::config::Config;
use wfe_worker::handlers::builtin_registry;
use wfe_worker::runner::RunnerEnv;
use wfe_worker::store::PgWorkerStore;
use wfe_worker::worker::{Worker, WorkerSettings};
use wfe_worker::{identity, logging, shutdown};

const CLOCK_SYNC_INTERVAL: Duration = Duration::from_secs(30);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    logging::init();
    let config = Config::from_env().context("invalid configuration")?;
    let pool = engine_store::db::connect(&config.database_url, config.db_max_connections)
        .await
        .context("could not connect to the database")?;

    let synced = Arc::new(SyncedClock::new(Arc::new(SystemClock)));
    let background = CancellationToken::new();
    if config.clock_sync_enabled {
        if let Err(err) = sync_clock(&pool, &synced, config.clock_skew_warn_ms).await {
            tracing::warn!(error = %err, "initial clock sync failed; using the local clock");
        }
        tokio::spawn(keep_clock_synced(
            pool.clone(),
            synced.clone(),
            config.clock_skew_warn_ms,
            background.clone(),
        ));
    }

    let worker_id = identity::worker_id(&identity::hostname(), rand::random::<u32>());
    let clock: Arc<dyn Clock> = synced;
    let http = reqwest::Client::builder()
        .build()
        .context("could not build the HTTP client")?;
    let env = Arc::new(RunnerEnv {
        store: Arc::new(PgWorkerStore::new(pool.clone(), Arc::new(RandomJitter))),
        clock,
        registry: builtin_registry(http),
        worker_id,
        lease_safety_ms: config.lease_safety_ms,
    });
    let settings = WorkerSettings {
        queues: config.queues.clone(),
        concurrency: config.concurrency,
        poll_interval: config.poll_interval,
        shutdown_grace: config.shutdown_grace,
    };

    let stop = CancellationToken::new();
    let signal_stop = stop.clone();
    tokio::spawn(async move {
        shutdown::signal().await;
        signal_stop.cancel();
    });

    Worker::new(env, settings).run(stop).await;
    background.cancel();
    pool.close().await;
    Ok(())
}

async fn keep_clock_synced(
    pool: PgPool,
    clock: Arc<SyncedClock>,
    warn_ms: i64,
    stop: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = tokio::time::sleep(CLOCK_SYNC_INTERVAL) => {}
        }
        if let Err(err) = sync_clock(&pool, &clock, warn_ms).await {
            tracing::warn!(error = %err, "clock sync failed; keeping the previous offset");
        }
    }
}
