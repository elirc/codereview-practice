//! Size limits shared by the API, the store and the worker.

/// Largest accepted job payload, in bytes of serialized JSON.
pub const MAX_PAYLOAD_BYTES: usize = 65_536;

/// Largest job result that is stored, in bytes of serialized JSON.
pub const MAX_RESULT_BYTES: usize = 262_144;

/// Longest stored error message, in characters.
pub const MAX_ERROR_CHARS: usize = 2_000;

/// Longest accepted unique key, in characters.
pub const MAX_UNIQUE_KEY_CHARS: usize = 200;

/// Returns the size of `value` serialized as compact JSON.
pub fn json_size(value: &serde_json::Value) -> usize {
    serde_json::to_vec(value).map(|v| v.len()).unwrap_or(usize::MAX)
}

/// Returns `message` cut to at most [`MAX_ERROR_CHARS`] characters.
pub fn truncate_error(message: &str) -> String {
    message.chars().take(MAX_ERROR_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_size_counts_serialized_bytes() {
        assert_eq!(json_size(&json!({"a": 1})), 7);
    }

    #[test]
    fn truncate_error_counts_characters_not_bytes() {
        let long: String = "é".repeat(MAX_ERROR_CHARS + 10);
        let cut = truncate_error(&long);
        assert_eq!(cut.chars().count(), MAX_ERROR_CHARS);
        assert_eq!(truncate_error("short"), "short");
    }
}
