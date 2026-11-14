//! The database operations a worker performs, behind a trait so tests can substitute them.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use engine_core::clock::JitterSource;
use engine_core::outcome::FailureKind;
use engine_core::state::JobState;
use engine_store::claim::{self, ClaimRef, ClaimedJob};
use engine_store::lease::{self, Completion};
use engine_store::StoreError;
use serde_json::Value;
use sqlx::PgPool;

/// Operations a worker performs on jobs.
#[async_trait]
pub trait WorkerStore: Send + Sync + 'static {
    /// Claims up to `limit` due jobs of `kinds` from `queue`.
    async fn claim(
        &self,
        queue: &str,
        kinds: &[String],
        worker_id: &str,
        limit: i64,
        now: DateTime<Utc>,
    ) -> Result<Vec<ClaimedJob>, StoreError>;

    /// Extends a claim's lease and returns whether cancellation was requested.
    async fn heartbeat(&self, claim: &ClaimRef, now: DateTime<Utc>) -> Result<bool, StoreError>;

    /// Records a successful result.
    async fn complete(
        &self,
        claim: &ClaimRef,
        result: &Value,
        now: DateTime<Utc>,
    ) -> Result<Completion, StoreError>;

    /// Records a handler error and returns the job's new state.
    async fn fail(
        &self,
        claim: &ClaimRef,
        kind: FailureKind,
        message: &str,
        now: DateTime<Utc>,
    ) -> Result<JobState, StoreError>;

    /// Gives a claim back without using up an attempt.
    async fn release(&self, claim: &ClaimRef, now: DateTime<Utc>) -> Result<JobState, StoreError>;
}

/// [`WorkerStore`] backed by Postgres.
pub struct PgWorkerStore {
    pool: PgPool,
    jitter: Arc<dyn JitterSource>,
}

impl PgWorkerStore {
    pub fn new(pool: PgPool, jitter: Arc<dyn JitterSource>) -> Self {
        Self { pool, jitter }
    }
}

#[async_trait]
impl WorkerStore for PgWorkerStore {
    async fn claim(
        &self,
        queue: &str,
        kinds: &[String],
        worker_id: &str,
        limit: i64,
        now: DateTime<Utc>,
    ) -> Result<Vec<ClaimedJob>, StoreError> {
        claim::claim(&self.pool, queue, kinds, worker_id, limit, now).await
    }

    async fn heartbeat(&self, claim: &ClaimRef, now: DateTime<Utc>) -> Result<bool, StoreError> {
        lease::heartbeat(&self.pool, claim, now).await
    }

    async fn complete(
        &self,
        claim: &ClaimRef,
        result: &Value,
        now: DateTime<Utc>,
    ) -> Result<Completion, StoreError> {
        lease::complete(&self.pool, claim, result, now).await
    }

    async fn fail(
        &self,
        claim: &ClaimRef,
        kind: FailureKind,
        message: &str,
        now: DateTime<Utc>,
    ) -> Result<JobState, StoreError> {
        lease::fail(&self.pool, claim, kind, message, now, self.jitter.as_ref()).await
    }

    async fn release(&self, claim: &ClaimRef, now: DateTime<Utc>) -> Result<JobState, StoreError> {
        lease::release(&self.pool, claim, now).await
    }
}
