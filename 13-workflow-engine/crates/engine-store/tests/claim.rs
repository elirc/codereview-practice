mod common;

use std::collections::HashSet;

use chrono::Duration;
use common::*;
use engine_store::claim::claim;
use engine_store::jobs::{list_attempts, NewJob};
use engine_store::queues::{get_queue, set_queue_paused, RateLimit};
use serde_json::json;
use sqlx::PgPool;

fn with_priority(queue: &str, priority: i32, offset_secs: i64) -> NewJob {
    let mut new = NewJob::new(queue, "work", json!({}), t0() + secs(offset_secs));
    new.priority = priority;
    new
}

#[sqlx::test(migrations = "../../migrations")]
async fn claims_by_priority_then_run_at_then_id(pool: PgPool) {
    make_queue(&pool, "q").await;
    let low = add_job_with(&pool, with_priority("q", 0, 0), t0() - secs(100)).await;
    let mid_late = add_job_with(&pool, with_priority("q", 5, -10), t0() - secs(100)).await;
    let mid_early = add_job_with(&pool, with_priority("q", 5, -20), t0() - secs(100)).await;
    let high = add_job_with(&pool, with_priority("q", 9, 0), t0() - secs(100)).await;
    let tie_a = add_job_with(&pool, with_priority("q", 3, -5), t0() - secs(100)).await;
    let tie_b = add_job_with(&pool, with_priority("q", 3, -5), t0() - secs(100)).await;
    let (first_tie, second_tie) = if tie_a.id < tie_b.id {
        (tie_a.id, tie_b.id)
    } else {
        (tie_b.id, tie_a.id)
    };

    let claimed = claim(&pool, "q", &kinds(&["work"]), WORKER_A, 10, t0())
        .await
        .unwrap();
    let order: Vec<_> = claimed.iter().map(|j| j.id).collect();
    assert_eq!(
        order,
        vec![high.id, mid_early.id, mid_late.id, first_tie, second_tie, low.id]
    );

    make_queue(&pool, "r").await;
    let a = add_job_with(&pool, with_priority("r", 1, 0), t0()).await;
    let b = add_job_with(&pool, with_priority("r", 8, 0), t0()).await;
    let first = claim(&pool, "r", &kinds(&["work"]), WORKER_A, 1, t0())
        .await
        .unwrap();
    assert_eq!(first[0].id, b.id);
    let second = claim(&pool, "r", &kinds(&["work"]), WORKER_A, 1, t0())
        .await
        .unwrap();
    assert_eq!(second[0].id, a.id);
}

#[sqlx::test(migrations = "../../migrations")]
async fn claim_sets_the_lease_and_records_an_attempt(pool: PgPool) {
    make_queue(&pool, "q").await;
    let job = add_job(&pool, "q", "work", t0()).await;
    let claimed = claim(&pool, "q", &kinds(&["work"]), WORKER_A, 1, t0())
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    let c = &claimed[0];
    assert_eq!(c.id, job.id);
    assert_eq!(c.attempt, 1);
    assert_eq!(c.lease_epoch, 1);
    assert_eq!(c.lease_expires_at, t0() + secs(60));
    assert_eq!(job_state(&pool, job.id).await, "running");

    let attempts = list_attempts(&pool, job.id).await.unwrap();
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].worker_id, WORKER_A);
    assert_eq!(attempts[0].lease_epoch, 1);
    assert_eq!(attempts[0].outcome, None);
}

#[sqlx::test(migrations = "../../migrations")]
async fn future_jobs_wait_until_exactly_run_at(pool: PgPool) {
    make_queue(&pool, "q").await;
    let job = add_job(&pool, "q", "work", t0() + secs(30)).await;
    let k = kinds(&["work"]);
    let early = claim(&pool, "q", &k, WORKER_A, 1, t0() + secs(30) - Duration::milliseconds(1))
        .await
        .unwrap();
    assert!(early.is_empty());
    let on_time = claim(&pool, "q", &k, WORKER_A, 1, t0() + secs(30))
        .await
        .unwrap();
    assert_eq!(on_time.len(), 1);
    assert_eq!(on_time[0].id, job.id);
}

#[sqlx::test(migrations = "../../migrations")]
async fn unlisted_kinds_stay_pending_without_blocking_others(pool: PgPool) {
    make_queue(&pool, "q").await;
    let mut other = NewJob::new("q", "nobody.handles", json!({}), t0());
    other.priority = 9;
    let other = add_job_with(&pool, other, t0()).await;
    let mine = add_job(&pool, "q", "work", t0()).await;

    let claimed = claim(&pool, "q", &kinds(&["work"]), WORKER_A, 5, t0())
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].id, mine.id);
    assert_eq!(job_state(&pool, other.id).await, "pending");
}

#[sqlx::test(migrations = "../../migrations")]
async fn paused_queue_yields_nothing_until_resumed(pool: PgPool) {
    make_queue(&pool, "q").await;
    let first = add_job(&pool, "q", "work", t0()).await;
    let second = add_job(&pool, "q", "work", t0() + secs(1)).await;
    set_queue_paused(&pool, "q", true).await.unwrap();
    let k = kinds(&["work"]);
    assert!(claim(&pool, "q", &k, WORKER_A, 5, t0() + secs(5))
        .await
        .unwrap()
        .is_empty());

    set_queue_paused(&pool, "q", false).await.unwrap();
    let claimed = claim(&pool, "q", &k, WORKER_A, 5, t0() + secs(5))
        .await
        .unwrap();
    let ids: Vec<_> = claimed.iter().map(|j| j.id).collect();
    assert_eq!(ids, vec![first.id, second.id]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn locked_candidates_are_skipped(pool: PgPool) {
    make_queue(&pool, "q").await;
    let first = add_job(&pool, "q", "work", t0()).await;
    let second = add_job(&pool, "q", "work", t0() + secs(1)).await;

    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE")
        .bind(first.id)
        .execute(&mut *blocker)
        .await
        .unwrap();

    let claimed = claim(&pool, "q", &kinds(&["work"]), WORKER_A, 1, t0() + secs(5))
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].id, second.id);
    blocker.rollback().await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_claimers_never_claim_a_job_twice(pool: PgPool) {
    make_queue(&pool, "bulk").await;
    for i in 0..100 {
        add_job(&pool, "bulk", "work", t0() - secs(i)).await;
    }
    let mut handles = Vec::new();
    for w in 0..20 {
        let pool = pool.clone();
        handles.push(tokio::spawn(async move {
            let worker = format!("worker-{w}");
            let k = vec!["work".to_string()];
            let mut mine = Vec::new();
            loop {
                let batch = claim(&pool, "bulk", &k, &worker, 3, t0()).await.unwrap();
                if batch.is_empty() {
                    break;
                }
                mine.extend(batch.into_iter().map(|j| j.id));
            }
            mine
        }));
    }
    let mut all = Vec::new();
    for handle in handles {
        all.extend(handle.await.unwrap());
    }
    let unique: HashSet<_> = all.iter().copied().collect();
    assert_eq!(all.len(), 100);
    assert_eq!(unique.len(), 100);
    let attempts: i64 = sqlx::query_scalar("SELECT count(*) FROM job_attempts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(attempts, 100);
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrency_cap_holds_across_claimers(pool: PgPool) {
    let mut spec = queue_spec("capped");
    spec.max_concurrency = Some(2);
    make_queue_with(&pool, spec).await;
    for _ in 0..6 {
        add_job(&pool, "capped", "work", t0()).await;
    }
    let mut handles = Vec::new();
    for w in 0..5 {
        let pool = pool.clone();
        handles.push(tokio::spawn(async move {
            claim(&pool, "capped", &["work".to_string()], &format!("w{w}"), 5, t0())
                .await
                .unwrap()
        }));
    }
    let mut claimed = Vec::new();
    for handle in handles {
        claimed.extend(handle.await.unwrap());
    }
    assert_eq!(claimed.len(), 2);
    assert_eq!(running_count(&pool, "capped").await, 2);

    let k = kinds(&["work"]);
    assert!(claim(&pool, "capped", &k, WORKER_A, 5, t0())
        .await
        .unwrap()
        .is_empty());
    force_succeeded(&pool, claimed[0].id, t0()).await;
    let next = claim(&pool, "capped", &k, WORKER_A, 5, t0()).await.unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(running_count(&pool, "capped").await, 2);
}

#[sqlx::test(migrations = "../../migrations")]
async fn rate_limit_releases_a_burst_then_the_steady_rate(pool: PgPool) {
    let mut spec = queue_spec("limited");
    spec.rate_limit = Some(RateLimit {
        per_minute: 60,
        burst: 10,
    });
    make_queue_with(&pool, spec).await;
    for _ in 0..30 {
        add_job(&pool, "limited", "work", t0()).await;
    }
    let k = kinds(&["work"]);
    let at = |ms: i64| t0() + Duration::milliseconds(ms);

    let burst = claim(&pool, "limited", &k, WORKER_A, 100, at(0)).await.unwrap();
    assert_eq!(burst.len(), 10);
    let half_second = claim(&pool, "limited", &k, WORKER_A, 100, at(500))
        .await
        .unwrap();
    assert_eq!(half_second.len(), 0);
    let one_second = claim(&pool, "limited", &k, WORKER_A, 100, at(1000))
        .await
        .unwrap();
    assert_eq!(one_second.len(), 1);
    let two_seconds = claim(&pool, "limited", &k, WORKER_A, 100, at(2000))
        .await
        .unwrap();
    assert_eq!(two_seconds.len(), 1);

    let after_idle = claim(&pool, "limited", &k, WORKER_A, 100, at(302_000))
        .await
        .unwrap();
    assert_eq!(after_idle.len(), 10);
}

#[sqlx::test(migrations = "../../migrations")]
async fn clock_stepping_back_adds_no_tokens(pool: PgPool) {
    let mut spec = queue_spec("limited");
    spec.rate_limit = Some(RateLimit {
        per_minute: 60,
        burst: 2,
    });
    make_queue_with(&pool, spec).await;
    for _ in 0..5 {
        add_job(&pool, "limited", "work", t0() - secs(60)).await;
    }
    let k = kinds(&["work"]);
    let start = t0() + secs(10);
    assert_eq!(
        claim(&pool, "limited", &k, WORKER_A, 5, start).await.unwrap().len(),
        2
    );
    let before = get_queue(&pool, "limited").await.unwrap();

    let earlier = start - secs(30);
    assert!(claim(&pool, "limited", &k, WORKER_A, 5, earlier)
        .await
        .unwrap()
        .is_empty());
    let after = get_queue(&pool, "limited").await.unwrap();
    assert_eq!(after.rate_tokens_milli, 0);
    assert_eq!(after.rate_refilled_at, before.rate_refilled_at);
    assert!(after.rate_refilled_at >= start);
}
