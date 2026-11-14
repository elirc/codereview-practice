mod common;

use std::collections::HashSet;

use chrono::{DateTime, Duration, TimeZone, Utc};
use common::*;
use engine_core::cron_plan::CatchupPolicy;
use engine_store::models::Job;
use engine_store::queues::set_queue_paused;
use engine_store::schedules::{
    create_schedule, get_schedule, pause_schedule, resume_schedule, run_scheduler_once,
    update_schedule, NewSchedule, Schedule, SchedulePatch,
};
use engine_store::StoreError;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

fn at(h: u32, m: u32, s: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 1, 5, h, m, s).unwrap()
}

fn spec(name: &str, cron: &str, catchup: CatchupPolicy) -> NewSchedule {
    NewSchedule {
        name: name.to_string(),
        cron_expr: cron.to_string(),
        queue: "q".to_string(),
        kind: "report.build".to_string(),
        payload: json!({ "report": name }),
        priority: 7,
        catchup,
        max_catchup: 10,
        paused: false,
    }
}

async fn every_five(pool: &PgPool, catchup: CatchupPolicy) -> Schedule {
    create_schedule(pool, &spec("five", "0 */5 * * * *", catchup), at(12, 0, 0))
        .await
        .unwrap()
}

async fn jobs_of(pool: &PgPool, schedule_id: Uuid) -> Vec<Job> {
    sqlx::query_as::<_, Job>(
        "SELECT id, queue, kind, payload, priority, state, run_at, attempt, max_attempts, \
         lease_seconds, lease_epoch, lease_owner, lease_expires_at, heartbeat_at, \
         cancel_requested, unique_key, result, last_error, dead_reason, schedule_id, \
         scheduled_for, workflow_run_id, step_key, created_by_token_id, created_at, \
         started_at, finished_at FROM jobs WHERE schedule_id = $1 ORDER BY scheduled_for",
    )
    .bind(schedule_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn first_fire_time_is_after_creation(pool: PgPool) {
    make_queue(&pool, "q").await;
    let s = every_five(&pool, CatchupPolicy::Skip).await;
    assert_eq!(s.next_fire_at, at(12, 5, 0));
    assert_eq!(s.last_fire_at, None);
}

#[sqlx::test(migrations = "../../migrations")]
async fn invalid_expressions_and_unknown_queues_are_rejected(pool: PgPool) {
    make_queue(&pool, "q").await;
    let err = create_schedule(&pool, &spec("bad", "every day", CatchupPolicy::Skip), at(12, 0, 0))
        .await
        .unwrap_err();
    assert!(matches!(err, StoreError::InvalidCron(_)));

    let weekdays = spec("weekdays", "0 0 9 * * Mon-Fri", CatchupPolicy::Skip);
    create_schedule(&pool, &weekdays, at(12, 0, 0)).await.unwrap();

    let mut elsewhere = spec("elsewhere", "0 * * * * *", CatchupPolicy::Skip);
    elsewhere.queue = "missing".to_string();
    let err = create_schedule(&pool, &elsewhere, at(12, 0, 0)).await.unwrap_err();
    assert!(matches!(err, StoreError::UnknownQueue(_)));
}

#[sqlx::test(migrations = "../../migrations")]
async fn on_time_fire_creates_one_job_due_now(pool: PgPool) {
    make_queue(&pool, "q").await;
    let s = every_five(&pool, CatchupPolicy::Skip).await;
    assert_eq!(run_scheduler_once(&pool, at(12, 4, 59)).await.unwrap(), 0);

    let now = at(12, 5, 0) + Duration::milliseconds(400);
    assert_eq!(run_scheduler_once(&pool, now).await.unwrap(), 1);
    let jobs = jobs_of(&pool, s.id).await;
    assert_eq!(jobs.len(), 1);
    let job = &jobs[0];
    assert_eq!(job.run_at, now);
    assert_eq!(job.scheduled_for, Some(at(12, 5, 0)));
    assert_eq!(job.priority, 7);
    assert_eq!(job.kind, "report.build");
    assert_eq!(
        job.unique_key.as_deref(),
        Some(format!("schedule:{}:2026-01-05T12:05:00Z", s.id).as_str())
    );

    let reloaded = get_schedule(&pool, s.id).await.unwrap();
    assert_eq!(reloaded.last_fire_at, Some(at(12, 5, 0)));
    assert_eq!(reloaded.next_fire_at, at(12, 10, 0));
    assert_eq!(run_scheduler_once(&pool, now).await.unwrap(), 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn skip_after_downtime_creates_nothing_and_resumes_at_the_next_slot(pool: PgPool) {
    make_queue(&pool, "q").await;
    let s = every_five(&pool, CatchupPolicy::Skip).await;
    run_scheduler_once(&pool, at(15, 2, 30)).await.unwrap();
    assert!(jobs_of(&pool, s.id).await.is_empty());
    assert_eq!(get_schedule(&pool, s.id).await.unwrap().next_fire_at, at(15, 5, 0));
}

#[sqlx::test(migrations = "../../migrations")]
async fn latest_after_downtime_creates_one_job_for_the_newest_slot(pool: PgPool) {
    make_queue(&pool, "q").await;
    let s = every_five(&pool, CatchupPolicy::Latest).await;
    let now = at(15, 2, 30);
    assert_eq!(run_scheduler_once(&pool, now).await.unwrap(), 1);
    let jobs = jobs_of(&pool, s.id).await;
    assert_eq!(jobs[0].scheduled_for, Some(at(15, 0, 0)));
    assert!(jobs[0].run_at >= now && jobs[0].run_at < now + Duration::seconds(30));
}

#[sqlx::test(migrations = "../../migrations")]
async fn all_after_downtime_creates_the_most_recent_ten_spaced_out(pool: PgPool) {
    make_queue(&pool, "q").await;
    let s = every_five(&pool, CatchupPolicy::All).await;
    let now = at(15, 2, 30);
    assert_eq!(run_scheduler_once(&pool, now).await.unwrap(), 10);
    let jobs = jobs_of(&pool, s.id).await;
    assert_eq!(jobs.len(), 10);
    assert_eq!(jobs[0].scheduled_for, Some(at(14, 15, 0)));
    assert_eq!(jobs[9].scheduled_for, Some(at(15, 0, 0)));
    for pair in jobs.windows(2) {
        assert_eq!(pair[1].run_at - pair[0].run_at, Duration::seconds(5));
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_fire_thirty_seconds_late_runs_immediately_under_every_policy(pool: PgPool) {
    make_queue(&pool, "q").await;
    let now = at(12, 5, 30);
    for (i, policy) in CatchupPolicy::ALL.into_iter().enumerate() {
        let s = create_schedule(
            &pool,
            &spec(&format!("late-{i}"), "0 */5 * * * *", policy),
            at(12, 0, 0),
        )
        .await
        .unwrap();
        run_scheduler_once(&pool, now).await.unwrap();
        let jobs = jobs_of(&pool, s.id).await;
        assert_eq!(jobs.len(), 1, "{policy}");
        assert_eq!(jobs[0].run_at, now, "{policy}");
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_fire_sixty_one_seconds_late_is_skipped_by_skip(pool: PgPool) {
    make_queue(&pool, "q").await;
    let s = every_five(&pool, CatchupPolicy::Skip).await;
    run_scheduler_once(&pool, at(12, 6, 1)).await.unwrap();
    assert!(jobs_of(&pool, s.id).await.is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn two_concurrent_scheduler_passes_create_each_fire_once(pool: PgPool) {
    make_queue(&pool, "q").await;
    let s = every_five(&pool, CatchupPolicy::All).await;
    let now = at(12, 20, 10);
    let a = tokio::spawn({
        let pool = pool.clone();
        async move { run_scheduler_once(&pool, now).await.unwrap() }
    });
    let b = tokio::spawn({
        let pool = pool.clone();
        async move { run_scheduler_once(&pool, now).await.unwrap() }
    });
    let total = a.await.unwrap() + b.await.unwrap();
    assert_eq!(total, 4);
    let jobs = jobs_of(&pool, s.id).await;
    let fires: HashSet<_> = jobs.iter().map(|j| j.scheduled_for).collect();
    assert_eq!(jobs.len(), 4);
    assert_eq!(fires.len(), 4);
}

#[sqlx::test(migrations = "../../migrations")]
async fn pause_and_resume_do_not_catch_up(pool: PgPool) {
    make_queue(&pool, "q").await;
    let s = every_five(&pool, CatchupPolicy::All).await;
    pause_schedule(&pool, s.id).await.unwrap();
    assert_eq!(run_scheduler_once(&pool, at(13, 0, 0)).await.unwrap(), 0);

    let now = at(14, 2, 0);
    let resumed = resume_schedule(&pool, s.id, now).await.unwrap();
    assert!(!resumed.paused);
    assert_eq!(resumed.next_fire_at, at(14, 5, 0));
    assert_eq!(run_scheduler_once(&pool, now).await.unwrap(), 0);
    assert!(jobs_of(&pool, s.id).await.is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn editing_the_expression_recomputes_the_next_fire_time(pool: PgPool) {
    make_queue(&pool, "q").await;
    let s = every_five(&pool, CatchupPolicy::Skip).await;
    let patch = SchedulePatch {
        cron_expr: Some("0 0 * * * *".to_string()),
        ..SchedulePatch::default()
    };
    let updated = update_schedule(&pool, s.id, &patch, at(12, 30, 0)).await.unwrap();
    assert_eq!(updated.next_fire_at, at(13, 0, 0));
    let bad = SchedulePatch {
        cron_expr: Some("nope".to_string()),
        ..SchedulePatch::default()
    };
    let err = update_schedule(&pool, s.id, &bad, at(12, 30, 0)).await.unwrap_err();
    assert!(matches!(err, StoreError::InvalidCron(_)));
}

#[sqlx::test(migrations = "../../migrations")]
async fn an_invalid_stored_expression_pauses_the_schedule(pool: PgPool) {
    make_queue(&pool, "q").await;
    let s = every_five(&pool, CatchupPolicy::Skip).await;
    sqlx::query("UPDATE schedules SET cron_expr = 'garbage' WHERE id = $1")
        .bind(s.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(run_scheduler_once(&pool, at(12, 5, 0)).await.unwrap(), 0);
    assert!(get_schedule(&pool, s.id).await.unwrap().paused);
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_paused_queue_still_receives_scheduled_jobs(pool: PgPool) {
    make_queue(&pool, "q").await;
    set_queue_paused(&pool, "q", true).await.unwrap();
    let s = every_five(&pool, CatchupPolicy::Skip).await;
    run_scheduler_once(&pool, at(12, 5, 0)).await.unwrap();
    assert_eq!(jobs_of(&pool, s.id).await.len(), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_week_of_downtime_on_a_per_second_schedule_is_bounded(pool: PgPool) {
    make_queue(&pool, "q").await;
    let mut every_second = spec("tick", "* * * * * *", CatchupPolicy::All);
    every_second.max_catchup = 100;
    let s = create_schedule(&pool, &every_second, at(12, 0, 0)).await.unwrap();
    let now = at(12, 0, 0) + Duration::days(7);
    assert_eq!(run_scheduler_once(&pool, now).await.unwrap(), 100);
    let jobs = jobs_of(&pool, s.id).await;
    let horizon = now - Duration::hours(24);
    assert!(jobs.iter().all(|j| j.scheduled_for.unwrap() >= horizon));
    assert_eq!(
        get_schedule(&pool, s.id).await.unwrap().next_fire_at,
        now + Duration::seconds(1)
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn many_schedules_due_together_get_spread_out(pool: PgPool) {
    make_queue(&pool, "q").await;
    for i in 0..100 {
        create_schedule(
            &pool,
            &spec(&format!("s{i:03}"), "0 */5 * * * *", CatchupPolicy::Latest),
            at(12, 0, 0),
        )
        .await
        .unwrap();
    }
    let now = at(15, 2, 30);
    let mut created = 0;
    for _ in 0..5 {
        created += run_scheduler_once(&pool, now).await.unwrap();
    }
    assert_eq!(created, 100);
    let run_ats: HashSet<DateTime<Utc>> =
        sqlx::query_scalar::<_, DateTime<Utc>>("SELECT run_at FROM jobs")
            .fetch_all(&pool)
            .await
            .unwrap()
            .into_iter()
            .collect();
    assert!(run_ats.len() > 1);
}
