//! Generation of API token values.

use std::fmt::Write;
use std::sync::atomic::{AtomicU64, Ordering};

use rand::RngCore;

/// Prefix of every generated token value.
pub const TOKEN_PREFIX: &str = "wfe_";

/// Source of new token values.
pub trait SecretSource: Send + Sync {
    /// Returns a new token value.
    fn token(&self) -> String;
}

/// Tokens made of 32 random bytes from the operating system's generator.
#[derive(Debug, Default, Clone, Copy)]
pub struct RandomSecrets;

impl SecretSource for RandomSecrets {
    fn token(&self) -> String {
        let mut bytes = [0_u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let mut out = String::with_capacity(TOKEN_PREFIX.len() + 64);
        out.push_str(TOKEN_PREFIX);
        for b in bytes {
            let _ = write!(out, "{b:02x}");
        }
        out
    }
}

/// Tokens numbered from 1 upwards.
#[derive(Debug, Default)]
pub struct SequentialSecrets {
    next: AtomicU64,
}

impl SecretSource for SequentialSecrets {
    fn token(&self) -> String {
        let n = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        format!("{TOKEN_PREFIX}{n:064x}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_tokens_are_prefixed_hex_of_256_bits() {
        let token = RandomSecrets.token();
        assert!(token.starts_with(TOKEN_PREFIX));
        let hex = &token[TOKEN_PREFIX.len()..];
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(RandomSecrets.token(), token);
    }

    #[test]
    fn sequential_tokens_are_predictable() {
        let secrets = SequentialSecrets::default();
        assert_eq!(secrets.token(), format!("wfe_{:064x}", 1));
        assert_eq!(secrets.token(), format!("wfe_{:064x}", 2));
    }
}
