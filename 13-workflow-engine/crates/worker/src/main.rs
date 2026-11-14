use anyhow::Context;
use wfe_worker::config::Config;
use wfe_worker::logging;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    logging::init();
    let config = Config::from_env().context("invalid configuration")?;
    let pool = engine_store::db::connect(&config.database_url, config.db_max_connections)
        .await
        .context("could not connect to the database")?;
    tracing::info!(queues = ?config.queues, "worker started");
    tokio::signal::ctrl_c()
        .await
        .context("could not listen for ctrl-c")?;
    pool.close().await;
    Ok(())
}
