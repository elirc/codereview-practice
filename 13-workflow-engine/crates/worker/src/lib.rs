//! Worker process for the workflow engine: claims jobs, runs handlers and reports outcomes.

pub mod config;
pub mod handlers;
pub mod identity;
pub mod logging;
pub mod runner;
pub mod shutdown;
pub mod store;
pub mod worker;
