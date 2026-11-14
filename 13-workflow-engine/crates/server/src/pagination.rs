use engine_store::page::TimeCursor;

use crate::error::ApiError;

pub const DEFAULT_LIMIT: i64 = 50;
pub const MAX_LIMIT: i64 = 200;

/// Returns the page size for a requested `limit`.
pub fn page_limit(raw: Option<i64>) -> Result<i64, ApiError> {
    match raw {
        None => Ok(DEFAULT_LIMIT),
        Some(n) if (1..=MAX_LIMIT).contains(&n) => Ok(n),
        Some(_) => Err(ApiError::field("limit", "must be between 1 and 200")),
    }
}

/// Parses an `after` cursor for listings ordered by creation time.
pub fn time_cursor(raw: Option<&str>) -> Result<Option<TimeCursor>, ApiError> {
    match raw {
        None | Some("") => Ok(None),
        Some(s) => TimeCursor::decode(s)
            .map(Some)
            .ok_or_else(|| ApiError::field("after", "is not a valid cursor")),
    }
}
