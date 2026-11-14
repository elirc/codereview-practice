//! Deleting finished jobs and runs after the retention period.

use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;

use crate::StoreError;

/// Rows deleted per statement.
pub const PURGE_BATCH: i64 = 1000;

/// Deletes standalone jobs and workflow runs (with their steps and jobs) that finished more
/// than `retention` before `now`. Jobs of runs are only deleted together with their run.
/// Returns the number of jobs and runs deleted.
pub async fn purge_finished(
    pool: &PgPool,
    now: DateTime<Utc>,
    retention: Duration,
) -> Result<usize, StoreError> {
    let cutoff = now - retention;
    let mut deleted: u64 = 0;
    loop {
        let batch = sqlx::query(
            "DELETE FROM jobs WHERE id IN ( \
                 SELECT id FROM jobs \
                 WHERE workflow_run_id IS NULL \
                   AND state IN ('succeeded', 'dead', 'cancelled') \
                   AND finished_at < $1 \
                 ORDER BY finished_at LIMIT $2)",
        )
        .bind(cutoff)
        .bind(PURGE_BATCH)
        .execute(pool)
        .await?
        .rows_affected();
        deleted += batch;
        if batch < PURGE_BATCH as u64 {
            break;
        }
    }
    loop {
        let batch = sqlx::query(
            "DELETE FROM workflow_runs WHERE id IN ( \
                 SELECT id FROM workflow_runs \
                 WHERE state <> 'running' AND finished_at < $1 \
                 ORDER BY finished_at LIMIT $2)",
        )
        .bind(cutoff)
        .bind(PURGE_BATCH)
        .execute(pool)
        .await?
        .rows_affected();
        deleted += batch;
        if batch < PURGE_BATCH as u64 {
            break;
        }
    }
    Ok(usize::try_from(deleted).unwrap_or(usize::MAX))
}
