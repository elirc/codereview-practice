//! Measuring the database clock.

use chrono::{DateTime, Utc};
use engine_core::clock::{estimate_offset_ms, SyncedClock};
use sqlx::PgPool;

use crate::StoreError;

/// Returns the database server's current time.
pub async fn database_now(pool: &PgPool) -> Result<DateTime<Utc>, StoreError> {
    let now = sqlx::query_scalar::<_, DateTime<Utc>>("SELECT now()")
        .fetch_one(pool)
        .await?;
    Ok(now)
}

/// Measures the database clock's offset from `clock`'s local clock, applies it, and returns
/// it in milliseconds. Offsets larger than `warn_ms` are logged.
pub async fn sync_clock(
    pool: &PgPool,
    clock: &SyncedClock,
    warn_ms: i64,
) -> Result<i64, StoreError> {
    let sent = clock.local_now();
    let remote = database_now(pool).await?;
    let received = clock.local_now();
    let offset_ms = estimate_offset_ms(sent, remote, received);
    clock.set_offset_ms(offset_ms);
    if offset_ms.abs() > warn_ms {
        tracing::warn!(offset_ms, warn_ms, "local clock differs from the database clock");
    } else {
        tracing::debug!(offset_ms, "clock synchronised with the database");
    }
    Ok(offset_ms)
}
