//! Cursor pagination helpers.

use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

/// Position after the last row of a page ordered by `created_at DESC, id DESC`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeCursor {
    pub created_at: DateTime<Utc>,
    pub id: Uuid,
}

impl TimeCursor {
    /// Returns the opaque string form of the cursor.
    pub fn encode(&self) -> String {
        hex::encode(format!("{}|{}", self.created_at.timestamp_micros(), self.id))
    }

    /// Parses a string produced by [`TimeCursor::encode`].
    pub fn decode(raw: &str) -> Option<Self> {
        let bytes = hex::decode(raw).ok()?;
        let text = String::from_utf8(bytes).ok()?;
        let (micros, id) = text.split_once('|')?;
        let micros: i64 = micros.parse().ok()?;
        let secs = micros.div_euclid(1_000_000);
        let nanos = u32::try_from(micros.rem_euclid(1_000_000) * 1_000).ok()?;
        let created_at = DateTime::from_timestamp(secs, nanos)?;
        let id = Uuid::parse_str(id).ok()?;
        Some(Self { created_at, id })
    }
}

/// One page of results.
#[derive(Debug, Clone, Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

impl<T> Page<T> {
    /// Builds a page from up to `limit + 1` rows; the extra row signals that more exist.
    pub fn from_rows(mut rows: Vec<T>, limit: i64, cursor_of: impl Fn(&T) -> String) -> Self {
        let limit = usize::try_from(limit.max(0)).unwrap_or(0);
        let next_cursor = if rows.len() > limit {
            rows.truncate(limit);
            rows.last().map(cursor_of)
        } else {
            None
        };
        Self {
            items: rows,
            next_cursor,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn cursor_round_trips() {
        let cursor = TimeCursor {
            created_at: Utc.with_ymd_and_hms(2026, 3, 4, 5, 6, 7).unwrap()
                + chrono::Duration::microseconds(123_456),
            id: Uuid::new_v4(),
        };
        assert_eq!(TimeCursor::decode(&cursor.encode()), Some(cursor));
    }

    #[test]
    fn garbage_cursors_are_rejected() {
        assert_eq!(TimeCursor::decode("zz"), None);
        assert_eq!(TimeCursor::decode(&hex::encode("12|not-a-uuid")), None);
    }

    #[test]
    fn page_reports_next_cursor_only_when_more_rows_exist() {
        let page = Page::from_rows(vec![1, 2, 3], 2, |n| n.to_string());
        assert_eq!(page.items, vec![1, 2]);
        assert_eq!(page.next_cursor.as_deref(), Some("2"));
        let page = Page::from_rows(vec![1, 2], 2, |n| n.to_string());
        assert_eq!(page.next_cursor, None);
    }
}
