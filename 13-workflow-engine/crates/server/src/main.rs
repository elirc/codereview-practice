use std::sync::Arc;

use anyhow::Context;
use engine_core::clock::SystemClock;
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
    let state = AppState::new(pool.clone(), Arc::new(SystemClock));
    let listener = tokio::net::TcpListener::bind(config.bind_addr)
        .await
        .with_context(|| format!("could not bind {}", config.bind_addr))?;
    tracing::info!(addr = %config.bind_addr, "listening");
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown::signal())
        .await
        .context("server error")?;
    pool.close().await;
    Ok(())
}
