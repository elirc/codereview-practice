//! Postgres persistence for the workflow engine. Every SQL statement the engine runs lives here.

pub mod db;
pub mod error;

pub use error::StoreError;

/// Schema migrations, applied by `wfe-server migrate`.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");
