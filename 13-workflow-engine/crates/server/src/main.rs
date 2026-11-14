use std::sync::Arc;

use anyhow::Context;
use engine_core::clock::{Clock, RandomJitter, SyncedClock, SystemClock};
use engine_core::secrets::RandomSecrets;
use engine_store::clock_sync::sync_clock;
use tokio_util::sync::CancellationToken;
use wfe_server::loops::{self, ClockSync, LoopContext};
use wfe_server::{build_router, config::Config, logging, shutdown, AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    logging::init();
    let config = Config::from_env().context("invalid configuration")?;
    let command = std::env::args().nth(1).unwrap_or_else(|| "serve".to_string());
    match command.as_str() {
        "serve" => serve(config).await,
        "migrate" => migrate(config).await,
        other => anyhow::bail!("unknown command {other:?}; expected serve or migrate"),
    }
}

async fn migrate(config: Config) -> anyhow::Result<()> {
    let pool = engine_store::db::connect(&config.database_url, 2)
        .await
        .context("could not connect to the database")?;
    engine_store::MIGRATOR
        .run(&pool)
        .await
        .context("migration failed")?;
    tracing::info!("migrations applied");
    pool.close().await;
    Ok(())
}

async fn serve(config: Config) -> anyhow::Result<()> {
    let pool = engine_store::db::connect(&config.database_url, config.db_max_connections)
        .await
        .context("could not connect to the database")?;
    let synced = Arc::new(SyncedClock::new(Arc::new(SystemClock)));
    if config.clock_sync_enabled {
        if let Err(err) = sync_clock(&pool, &synced, config.clock_skew_warn_ms).await {
            tracing::warn!(error = %err, "initial clock sync failed; using the local clock");
        }
    }
    let clock: Arc<dyn Clock> = synced.clone();
    let state = AppState::new(pool.clone(), clock.clone(), Arc::new(RandomSecrets));

    let loops_shutdown = CancellationToken::new();
    let loop_handles = if config.loops_enabled {
        let ctx = LoopContext {
            pool: pool.clone(),
            clock: clock.clone(),
            jitter: Arc::new(RandomJitter),
            clock_sync: config.clock_sync_enabled.then(|| ClockSync {
                clock: synced.clone(),
                warn_ms: config.clock_skew_warn_ms,
            }),
        };
        loops::spawn_all(ctx, loops_shutdown.clone())
    } else {
        Vec::new()
    };

    let listener = tokio::net::TcpListener::bind(config.bind_addr)
        .await
        .with_context(|| format!("could not bind {}", config.bind_addr))?;
    tracing::info!(addr = %config.bind_addr, "listening");
    let served = axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown::signal())
        .await;

    loops_shutdown.cancel();
    for handle in loop_handles {
        if let Err(err) = handle.await {
            tracing::error!(error = %err, "loop task ended abnormally");
        }
    }
    pool.close().await;
    served.context("server error")
}
