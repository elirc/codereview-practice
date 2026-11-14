use std::sync::Arc;

use engine_core::clock::Clock;
use engine_core::secrets::SecretSource;
use sqlx::PgPool;

/// Shared state handed to every request handler.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub clock: Arc<dyn Clock>,
    pub secrets: Arc<dyn SecretSource>,
}

impl AppState {
    /// Creates the state from a pool, a clock and a token generator.
    pub fn new(pool: PgPool, clock: Arc<dyn Clock>, secrets: Arc<dyn SecretSource>) -> Self {
        Self {
            pool,
            clock,
            secrets,
        }
    }
}
