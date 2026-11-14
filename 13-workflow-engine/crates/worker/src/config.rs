use std::str::FromStr;
use std::time::Duration;

use engine_core::names::is_queue_name;

/// Error raised when an environment variable is missing or malformed.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("environment variable {0} is required")]
    Missing(&'static str),
    #[error("environment variable {name} has invalid value {value:?}: {reason}")]
    Invalid {
        name: &'static str,
        value: String,
        reason: String,
    },
}

/// Settings for the `wfe-worker` binary, read once at start-up.
#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub db_max_connections: u32,
    pub queues: Vec<String>,
    pub concurrency: usize,
    pub poll_interval: Duration,
    pub shutdown_grace: Duration,
    pub lease_safety_ms: i64,
    pub clock_sync_enabled: bool,
    pub clock_skew_warn_ms: i64,
}

impl Config {
    /// Reads the configuration from the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Reads the configuration through `lookup`, which returns a variable's value if set.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let database_url = lookup("DATABASE_URL")
            .filter(|v| !v.trim().is_empty())
            .ok_or(ConfigError::Missing("DATABASE_URL"))?;
        let raw_queues = lookup("WORKER_QUEUES")
            .filter(|v| !v.trim().is_empty())
            .ok_or(ConfigError::Missing("WORKER_QUEUES"))?;
        let mut queues: Vec<String> = Vec::new();
        for name in raw_queues.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if !is_queue_name(name) {
                return Err(invalid("WORKER_QUEUES", name, "not a valid queue name"));
            }
            if !queues.iter().any(|q| q == name) {
                queues.push(name.to_string());
            }
        }
        if queues.is_empty() {
            return Err(invalid("WORKER_QUEUES", &raw_queues, "no queue names given"));
        }

        let concurrency: usize = parse_or(&lookup, "WORKER_CONCURRENCY", 8)?;
        if concurrency == 0 {
            return Err(invalid("WORKER_CONCURRENCY", "0", "must be at least 1"));
        }
        let poll_ms: u64 = parse_or(&lookup, "POLL_INTERVAL_MS", 500)?;
        if poll_ms == 0 {
            return Err(invalid("POLL_INTERVAL_MS", "0", "must be at least 1"));
        }
        let grace_seconds: u64 = parse_or(&lookup, "SHUTDOWN_GRACE_SECONDS", 30)?;
        let lease_safety_ms: i64 = parse_or(&lookup, "LEASE_SAFETY_MS", 2000)?;
        if lease_safety_ms < 0 {
            return Err(invalid(
                "LEASE_SAFETY_MS",
                &lease_safety_ms.to_string(),
                "must not be negative",
            ));
        }
        let db_max_connections: u32 = parse_or(
            &lookup,
            "DB_MAX_CONNECTIONS",
            u32::try_from(concurrency + 2).unwrap_or(u32::MAX),
        )?;
        if db_max_connections == 0 {
            return Err(invalid("DB_MAX_CONNECTIONS", "0", "must be at least 1"));
        }

        Ok(Self {
            database_url,
            db_max_connections,
            queues,
            concurrency,
            poll_interval: Duration::from_millis(poll_ms),
            shutdown_grace: Duration::from_secs(grace_seconds),
            lease_safety_ms,
            clock_sync_enabled: parse_bool(&lookup, "CLOCK_SYNC_ENABLED", true)?,
            clock_skew_warn_ms: parse_or(&lookup, "CLOCK_SKEW_WARN_MS", 5000)?,
        })
    }
}

fn invalid(name: &'static str, value: &str, reason: &str) -> ConfigError {
    ConfigError::Invalid {
        name,
        value: value.to_string(),
        reason: reason.to_string(),
    }
}

fn parse_or<T>(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &'static str,
    default: T,
) -> Result<T, ConfigError>
where
    T: FromStr,
    T::Err: std::fmt::Display,
{
    match lookup(name).filter(|v| !v.trim().is_empty()) {
        Some(raw) => raw
            .trim()
            .parse::<T>()
            .map_err(|e| invalid(name, &raw, &e.to_string())),
        None => Ok(default),
    }
}

fn parse_bool(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &'static str,
    default: bool,
) -> Result<bool, ConfigError> {
    match lookup(name).map(|v| v.trim().to_ascii_lowercase()) {
        None => Ok(default),
        Some(v) if v.is_empty() => Ok(default),
        Some(v) if v == "true" || v == "1" => Ok(true),
        Some(v) if v == "false" || v == "0" => Ok(false),
        Some(v) => Err(invalid(name, &v, "expected true or false")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn parses_queue_list_and_defaults() {
        let config = Config::from_lookup(lookup(&[
            ("DATABASE_URL", "postgres://x"),
            ("WORKER_QUEUES", "default, email,default"),
        ]))
        .unwrap();
        assert_eq!(config.queues, vec!["default", "email"]);
        assert_eq!(config.concurrency, 8);
        assert_eq!(config.poll_interval, Duration::from_millis(500));
        assert_eq!(config.shutdown_grace, Duration::from_secs(30));
        assert_eq!(config.lease_safety_ms, 2000);
    }

    #[test]
    fn rejects_invalid_queue_names() {
        let result = Config::from_lookup(lookup(&[
            ("DATABASE_URL", "postgres://x"),
            ("WORKER_QUEUES", "Default"),
        ]));
        assert!(matches!(result, Err(ConfigError::Invalid { .. })));
    }

    #[test]
    fn requires_worker_queues() {
        let result = Config::from_lookup(lookup(&[("DATABASE_URL", "postgres://x")]));
        assert!(matches!(result, Err(ConfigError::Missing("WORKER_QUEUES"))));
    }
}
