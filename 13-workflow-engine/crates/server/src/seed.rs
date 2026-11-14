//! Development data for `wfe-server seed`. Safe to run repeatedly.

use chrono::{DateTime, Utc};
use engine_core::authz::Role;
use engine_core::cron_plan::CatchupPolicy;
use engine_core::dag::StepDef;
use engine_store::jobs::{enqueue, NewJob};
use engine_store::queues::{create_queue, get_queue, NewQueue, RateLimit};
use engine_store::schedules::{create_schedule, NewSchedule};
use engine_store::tokens::{upsert_token, NewToken};
use engine_store::workflows::{
    create_definition, list_definition_versions, list_runs, start_run,
};
use engine_store::StoreError;
use serde_json::{json, Value};
use sqlx::PgPool;

/// Token values created by the seed. For local development only.
pub const SEED_TOKENS: [(&str, Role, &str); 4] = [
    (
        "seed admin",
        Role::Admin,
        "wfe_dev_admin_5f2b9c7e1a4d8e3f6b0c2a9d7e5f1b3c8a6d4e2f0b9c7a5e3d1f8b6c4a2e0d9f7b",
    ),
    (
        "seed operator",
        Role::Operator,
        "wfe_dev_operator_9a1c3e5f7b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a",
    ),
    (
        "seed viewer",
        Role::Viewer,
        "wfe_dev_viewer_2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a5c7e9b1d3f5a",
    ),
    (
        "seed submitter",
        Role::Submitter,
        "wfe_dev_submitter_7e9b1d3f5a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0b1d3f5a7c9e2b4d6f8a0c1e3b",
    ),
];

fn queue(name: &str) -> NewQueue {
    NewQueue {
        name: name.to_string(),
        max_concurrency: None,
        rate_limit: None,
        default_max_attempts: 5,
        default_lease_seconds: 60,
        backoff_base_ms: 1000,
        backoff_cap_ms: 3_600_000,
    }
}

fn step(key: &str, kind: &str, queue: &str, deps: &[&str], params: Value) -> StepDef {
    StepDef {
        key: key.to_string(),
        kind: kind.to_string(),
        queue: queue.to_string(),
        depends_on: deps.iter().map(|d| d.to_string()).collect(),
        params,
        max_attempts: None,
        lease_seconds: None,
        priority: None,
    }
}

async fn ensure_queue(pool: &PgPool, spec: NewQueue, now: DateTime<Utc>) -> anyhow::Result<()> {
    match get_queue(pool, &spec.name).await {
        Ok(_) => Ok(()),
        Err(StoreError::NotFound) => {
            create_queue(pool, &spec, now).await?;
            Ok(())
        }
        Err(err) => Err(err.into()),
    }
}

/// Creates queues, tokens, a schedule, a workflow definition, a few jobs and one run.
pub async fn run(pool: &PgPool, now: DateTime<Utc>) -> anyhow::Result<()> {
    ensure_queue(pool, queue("default"), now).await?;
    let mut email = queue("email");
    email.rate_limit = Some(RateLimit {
        per_minute: 60,
        burst: 10,
    });
    ensure_queue(pool, email, now).await?;
    let mut reports = queue("reports");
    reports.max_concurrency = Some(2);
    ensure_queue(pool, reports, now).await?;

    for (name, role, secret) in SEED_TOKENS {
        let queues = if role == Role::Submitter {
            vec!["email".to_string(), "default".to_string()]
        } else {
            Vec::new()
        };
        let new = NewToken {
            name: name.to_string(),
            role,
            queues,
        };
        upsert_token(pool, &new, secret, now).await?;
    }

    let nightly = NewSchedule {
        name: "nightly-report".to_string(),
        cron_expr: "0 0 2 * * *".to_string(),
        queue: "reports".to_string(),
        kind: "noop".to_string(),
        payload: json!({ "report": "daily-summary" }),
        priority: 5,
        catchup: CatchupPolicy::Latest,
        max_catchup: 10,
        paused: false,
    };
    match create_schedule(pool, &nightly, now).await {
        Ok(_) | Err(StoreError::InvalidState(_)) => {}
        Err(err) => return Err(err.into()),
    }

    if list_definition_versions(pool, "etl").await?.is_empty() {
        let steps = vec![
            step("extract", "sleep", "default", &[], json!({ "source": "orders" })),
            step("clean", "noop", "default", &["extract"], json!({})),
            step("enrich", "noop", "default", &["extract"], json!({})),
            step("load", "merge", "default", &["clean", "enrich"], json!({})),
        ];
        create_definition(pool, "etl", &steps, now).await?;
    }

    let samples = [
        ("seed:welcome", "noop", "email", json!({ "to": "user@example.com" })),
        ("seed:digest", "sleep", "default", json!({ "ms": 1500 })),
        (
            "seed:flaky",
            "fail",
            "default",
            json!({ "mode": "retryable", "succeed_on_attempt": 3 }),
        ),
        ("seed:broken", "fail", "default", json!({ "mode": "permanent" })),
    ];
    for (key, kind, queue, payload) in samples {
        let mut job = NewJob::new(queue, kind, payload, now);
        job.unique_key = Some(key.to_string());
        enqueue(pool, &job, now).await?;
    }

    if list_runs(pool, None, None, None, 1).await?.is_empty() {
        let definition = engine_store::workflows::find_definition(pool, "etl", None).await?;
        let input = json!({ "date": now.date_naive().to_string() });
        start_run(pool, &definition, &input, None, now).await?;
    }
    tracing::info!("seed data in place");
    Ok(())
}
