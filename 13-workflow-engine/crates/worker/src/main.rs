use std::sync::Arc;

use anyhow::Context;
use engine_core::clock::{Clock, RandomJitter, SystemClock};
use tokio_util::sync::CancellationToken;
use wfe_worker::config::Config;
use wfe_worker::handlers::builtin_registry;
use wfe_worker::runner::RunnerEnv;
use wfe_worker::store::PgWorkerStore;
use wfe_worker::worker::{Worker, WorkerSettings};
use wfe_worker::{identity, logging, shutdown};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    logging::init();
    let config = Config::from_env().context("invalid configuration")?;
    let pool = engine_store::db::connect(&config.database_url, config.db_max_connections)
        .await
        .context("could not connect to the database")?;

    let worker_id = identity::worker_id(&identity::hostname(), rand::random::<u32>());
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let http = reqwest::Client::builder()
        .build()
        .context("could not build the HTTP client")?;
    let env = Arc::new(RunnerEnv {
        store: Arc::new(PgWorkerStore::new(pool.clone(), Arc::new(RandomJitter))),
        clock,
        registry: builtin_registry(http),
        worker_id,
    });
    let settings = WorkerSettings {
        queues: config.queues.clone(),
        concurrency: config.concurrency,
        poll_interval: config.poll_interval,
    };

    let stop = CancellationToken::new();
    let signal_stop = stop.clone();
    tokio::spawn(async move {
        shutdown::signal().await;
        signal_stop.cancel();
    });

    Worker::new(env, settings).run(stop).await;
    pool.close().await;
    Ok(())
}
