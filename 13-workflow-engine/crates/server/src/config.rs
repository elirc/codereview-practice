use std::net::SocketAddr;
use std::str::FromStr;

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

/// Settings for the `wfe-server` binary, read once at start-up.
#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: SocketAddr,
    pub db_max_connections: u32,
    pub loops_enabled: bool,
    pub clock_sync_enabled: bool,
    pub clock_skew_warn_ms: i64,
    pub retention_days: i64,
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
        let config = Self {
            database_url,
            bind_addr: parse_or(&lookup, "BIND_ADDR", "0.0.0.0:8130".parse().ok())?,
            db_max_connections: parse_or(&lookup, "DB_MAX_CONNECTIONS", Some(10))?,
            loops_enabled: parse_bool(&lookup, "LOOPS_ENABLED", true)?,
            clock_sync_enabled: parse_bool(&lookup, "CLOCK_SYNC_ENABLED", true)?,
            clock_skew_warn_ms: parse_or(&lookup, "CLOCK_SKEW_WARN_MS", Some(5000))?,
            retention_days: parse_or(&lookup, "RETENTION_DAYS", Some(14))?,
        };
        if config.db_max_connections == 0 {
            return Err(invalid("DB_MAX_CONNECTIONS", "0", "must be at least 1"));
        }
        if config.retention_days < 1 {
            return Err(invalid(
                "RETENTION_DAYS",
                &config.retention_days.to_string(),
                "must be at least 1",
            ));
        }
        if config.clock_skew_warn_ms < 0 {
            return Err(invalid(
                "CLOCK_SKEW_WARN_MS",
                &config.clock_skew_warn_ms.to_string(),
                "must not be negative",
            ));
        }
        Ok(config)
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
    default: Option<T>,
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
        None => default.ok_or(ConfigError::Missing(name)),
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
    fn defaults_apply_when_only_database_url_is_set() {
        let config = Config::from_lookup(lookup(&[("DATABASE_URL", "postgres://x")])).unwrap();
        assert_eq!(config.bind_addr.port(), 8130);
        assert_eq!(config.retention_days, 14);
        assert!(config.loops_enabled);
    }

    #[test]
    fn missing_database_url_fails() {
        assert!(matches!(
            Config::from_lookup(lookup(&[])),
            Err(ConfigError::Missing("DATABASE_URL"))
        ));
    }

    #[test]
    fn malformed_values_fail() {
        let result = Config::from_lookup(lookup(&[
            ("DATABASE_URL", "postgres://x"),
            ("LOOPS_ENABLED", "maybe"),
        ]));
        assert!(matches!(result, Err(ConfigError::Invalid { .. })));
    }
}
