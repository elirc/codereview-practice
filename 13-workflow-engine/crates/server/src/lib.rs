//! HTTP API, background loops and admin console for the workflow engine.

pub mod auth;
pub mod config;
pub mod error;
pub mod extract;
pub mod logging;
pub mod loops;
pub mod pagination;
pub mod request_id;
pub mod routes;
pub mod seed;
pub mod shutdown;
pub mod state;
pub mod validate;

pub use routes::build_router;
pub use state::AppState;
