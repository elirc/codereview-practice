//! The worker's identity as recorded on its claims.

/// Returns the host name from the environment or `/etc/hostname`, or `worker` when unknown.
pub fn hostname() -> String {
    let candidates = [
        std::env::var("HOSTNAME").ok(),
        std::env::var("COMPUTERNAME").ok(),
        std::fs::read_to_string("/etc/hostname").ok(),
    ];
    candidates
        .into_iter()
        .flatten()
        .map(|name| sanitize(&name))
        .find(|name| !name.is_empty())
        .unwrap_or_else(|| "worker".to_string())
}

fn sanitize(name: &str) -> String {
    name.trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '.' || *c == '_')
        .take(64)
        .collect()
}

/// Returns `<hostname>-<suffix as 8 hex digits>`.
pub fn worker_id(hostname: &str, suffix: u32) -> String {
    format!("{hostname}-{suffix:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_id_has_eight_hex_digits() {
        assert_eq!(worker_id("box", 0xab), "box-000000ab");
        assert_eq!(worker_id("box", u32::MAX), "box-ffffffff");
    }

    #[test]
    fn sanitize_trims_and_drops_odd_characters() {
        assert_eq!(sanitize("  web 01\n"), "web01");
    }
}
