mod common;

use std::sync::Arc;

use chrono::{Duration, TimeZone, Utc};
use common::*;
use engine_core::clock::{Clock, FixedClock, FixedJitter, SyncedClock};
use engine_store::claim::claim;
use engine_store::clock_sync::{database_now, sync_clock};
use engine_store::jobs::{enqueue, NewJob};
use engine_store::lease::{complete, heartbeat};
use engine_store::reaper::reap_expired;
use serde_json::json;
use sqlx::PgPool;

fn close(a: chrono::DateTime<Utc>, b: chrono::DateTime<Utc>) -> bool {
    (a - b).num_milliseconds().abs() < 5_000
}

#[sqlx::test(migrations = "../../migrations")]
async fn sync_aligns_a_skewed_clock_with_the_database(pool: PgPool) {
    let far_off = Utc.with_ymd_and_hms(2001, 1, 1, 0, 0, 0).unwrap();
    let synced = SyncedClock::new(Arc::new(FixedClock::new(far_off)));
    let offset = sync_clock(&pool, &synced, 5_000).await.unwrap();
    assert_eq!(offset, synced.offset_ms());
    assert!(close(synced.now(), database_now(&pool).await.unwrap()));
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_fast_worker_clock_does_not_shorten_leases(pool: PgPool) {
    let db_now = database_now(&pool).await.unwrap();
    let fast_local = Arc::new(FixedClock::new(db_now + Duration::minutes(10)));
    let fast_worker = SyncedClock::new(fast_local);
    sync_clock(&pool, &fast_worker, 5_000).await.unwrap();

    make_queue(&pool, "q").await;
    let job = NewJob::new("q", "work", json!({}), db_now - Duration::seconds(1));
    enqueue(&pool, &job, db_now - Duration::seconds(1)).await.unwrap();

    let claimed = claim(&pool, "q", &kinds(&["work"]), WORKER_A, 1, fast_worker.now())
        .await
        .unwrap()
        .remove(0);
    assert!(close(claimed.lease_expires_at, db_now + Duration::seconds(60)));

    let server_view = database_now(&pool).await.unwrap();
    let reaped = reap_expired(&pool, server_view, &FixedJitter(0.5)).await.unwrap();
    assert_eq!(reaped, 0);

    heartbeat(&pool, &claimed.claim_ref(), fast_worker.now())
        .await
        .unwrap();
    complete(&pool, &claimed.claim_ref(), &json!("ok"), fast_worker.now())
        .await
        .unwrap();
}
