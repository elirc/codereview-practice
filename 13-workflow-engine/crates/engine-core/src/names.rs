//! Character rules for queue names, job kinds and workflow step keys.

fn matches(value: &str, max_len: usize, allowed: impl Fn(char) -> bool) -> bool {
    let len = value.chars().count();
    (1..=max_len).contains(&len) && value.chars().all(allowed)
}

/// Returns true when `name` matches `[a-z0-9_-]{1,64}`.
pub fn is_queue_name(name: &str) -> bool {
    matches(name, 64, |c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'
    })
}

/// Returns true when `kind` matches `[a-z0-9_.]{1,64}`.
pub fn is_kind(kind: &str) -> bool {
    matches(kind, 64, |c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.'
    })
}

/// Returns true when `key` matches `[a-z0-9_]{1,40}`.
pub fn is_step_key(key: &str) -> bool {
    matches(key, 40, |c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_names() {
        assert!(is_queue_name("email-high_2"));
        assert!(!is_queue_name(""));
        assert!(!is_queue_name("Email"));
        assert!(!is_queue_name("a.b"));
        assert!(is_queue_name(&"q".repeat(64)));
        assert!(!is_queue_name(&"q".repeat(65)));
    }

    #[test]
    fn kinds() {
        assert!(is_kind("email.send_v2"));
        assert!(!is_kind("email-send"));
        assert!(!is_kind(""));
    }

    #[test]
    fn step_keys() {
        assert!(is_step_key("fetch_1"));
        assert!(!is_step_key("fetch.1"));
        assert!(!is_step_key(&"k".repeat(41)));
    }
}
