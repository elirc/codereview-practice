use std::time::Duration;

use sqlx::postgres::{PgPool, PgPoolOptions};

/// Opens a connection pool to `url` with at most `max_connections` connections.
pub async fn connect(url: &str, max_connections: u32) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .connect(url)
        .await
}
