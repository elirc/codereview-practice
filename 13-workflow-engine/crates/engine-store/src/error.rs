use engine_core::dag::Problem;

/// Errors returned by store operations.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("not found")]
    NotFound,
    #[error("queue {0} does not exist")]
    UnknownQueue(String),
    #[error("{0}")]
    InvalidState(String),
    #[error("{field}: {message}")]
    Conflict { field: String, message: String },
    #[error("job belongs to a workflow run")]
    WorkflowJob,
    #[error("another live job holds the same unique key")]
    UniqueKeyConflict,
    #[error("lease lost")]
    LeaseLost,
    #[error("invalid cron expression: {0}")]
    InvalidCron(String),
    #[error("invalid workflow definition")]
    InvalidWorkflow(Vec<Problem>),
    #[error("stored data is inconsistent: {0}")]
    Corrupt(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Returns true when `err` is a unique violation on `constraint`.
pub fn is_unique_violation(err: &sqlx::Error, constraint: &str) -> bool {
    match err {
        sqlx::Error::Database(db) => {
            db.code().as_deref() == Some("23505") && db.constraint() == Some(constraint)
        }
        _ => false,
    }
}

/// Returns true when `err` is a foreign-key violation on `constraint`.
pub fn is_foreign_key_violation(err: &sqlx::Error, constraint: &str) -> bool {
    match err {
        sqlx::Error::Database(db) => {
            db.code().as_deref() == Some("23503") && db.constraint() == Some(constraint)
        }
        _ => false,
    }
}
