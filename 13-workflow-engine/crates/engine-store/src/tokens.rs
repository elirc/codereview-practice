//! API tokens, stored by the SHA-256 hash of their value.

use chrono::{DateTime, Utc};
use engine_core::authz::Role;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::models::{ApiToken, TOKEN_COLUMNS};
use crate::StoreError;

/// Returns the hex SHA-256 digest of a token value.
pub fn hash_token(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

/// Fields of a token to create.
#[derive(Debug, Clone)]
pub struct NewToken {
    pub name: String,
    pub role: Role,
    pub queues: Vec<String>,
}

/// Stores a token whose value is `secret` and returns it.
pub async fn create_token(
    pool: &PgPool,
    new: &NewToken,
    secret: &str,
    now: DateTime<Utc>,
) -> Result<ApiToken, StoreError> {
    let sql = format!(
        "INSERT INTO api_tokens (id, name, token_hash, role, queues, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING {TOKEN_COLUMNS}"
    );
    let token = sqlx::query_as::<_, ApiToken>(&sql)
        .bind(Uuid::new_v4())
        .bind(&new.name)
        .bind(hash_token(secret))
        .bind(new.role.as_str())
        .bind(&new.queues)
        .bind(now)
        .fetch_one(pool)
        .await?;
    Ok(token)
}

/// Stores a token with a known value, or updates the token that already has that value.
pub async fn upsert_token(
    pool: &PgPool,
    new: &NewToken,
    secret: &str,
    now: DateTime<Utc>,
) -> Result<ApiToken, StoreError> {
    let sql = format!(
        "INSERT INTO api_tokens (id, name, token_hash, role, queues, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT ON CONSTRAINT api_tokens_token_hash_key DO UPDATE \
         SET name = EXCLUDED.name, role = EXCLUDED.role, queues = EXCLUDED.queues, \
             revoked_at = NULL \
         RETURNING {TOKEN_COLUMNS}"
    );
    let token = sqlx::query_as::<_, ApiToken>(&sql)
        .bind(Uuid::new_v4())
        .bind(&new.name)
        .bind(hash_token(secret))
        .bind(new.role.as_str())
        .bind(&new.queues)
        .bind(now)
        .fetch_one(pool)
        .await?;
    Ok(token)
}

/// Finds the unrevoked token whose value is `secret`.
pub async fn find_active_token(
    pool: &PgPool,
    secret: &str,
) -> Result<Option<ApiToken>, StoreError> {
    let sql =
        format!("SELECT {TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL");
    let token = sqlx::query_as::<_, ApiToken>(&sql)
        .bind(hash_token(secret))
        .fetch_optional(pool)
        .await?;
    Ok(token)
}

/// Revokes a token and returns it. Revoking twice keeps the first revocation time.
pub async fn revoke_token(
    pool: &PgPool,
    id: Uuid,
    now: DateTime<Utc>,
) -> Result<ApiToken, StoreError> {
    let sql = format!(
        "UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1 \
         RETURNING {TOKEN_COLUMNS}"
    );
    sqlx::query_as::<_, ApiToken>(&sql)
        .bind(id)
        .bind(now)
        .fetch_optional(pool)
        .await?
        .ok_or(StoreError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_hex_sha256() {
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
