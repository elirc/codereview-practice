//! Pure domain logic for the workflow engine: job and workflow states, transition rules,
//! back-off, rate limiting, cron planning, workflow graphs and the clock abstraction.
//!
//! Nothing in this crate touches the database or the network.

pub mod clock;
pub mod limits;
pub mod names;
