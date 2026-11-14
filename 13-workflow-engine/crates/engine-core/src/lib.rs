//! Pure domain logic for the workflow engine: job and workflow states, transition rules,
//! back-off, rate limiting, cron planning, workflow graphs and the clock abstraction.
//!
//! Nothing in this crate touches the database or the network.

pub mod authz;
pub mod backoff;
pub mod clock;
pub mod cron_plan;
pub mod dag;
pub mod limits;
pub mod names;
pub mod outcome;
pub mod rate;
pub mod resolve;
pub mod secrets;
pub mod state;
