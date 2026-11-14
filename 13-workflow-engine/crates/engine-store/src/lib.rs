//! Postgres persistence for the workflow engine. Every SQL statement the engine runs lives here.

pub mod claim;
pub mod clock_sync;
pub mod db;
pub mod error;
pub mod jobs;
pub mod lease;
pub mod models;
pub mod page;
pub mod progress;
pub mod queues;
pub mod reaper;
pub mod schedules;
pub mod tokens;
pub mod workflows;

pub use error::StoreError;

/// Schema migrations, applied by `wfe-server migrate`.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");
