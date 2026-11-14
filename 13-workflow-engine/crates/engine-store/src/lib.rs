//! Postgres persistence for the workflow engine. Every SQL statement the engine runs lives here.

pub mod db;
pub mod error;

pub use error::StoreError;
