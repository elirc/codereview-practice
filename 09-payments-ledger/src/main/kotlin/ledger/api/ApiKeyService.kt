package ledger.api

import ledger.config.IdSource
import ledger.config.Tx
import ledger.config.instant
import ledger.config.instantOrNull
import ledger.config.toDb
import ledger.config.uuid
import ledger.config.uuidOrNull
import ledger.domain.Caller
import ledger.domain.Hashing
import ledger.domain.NotFoundException
import ledger.domain.Role
import ledger.domain.validationFailed
import ledger.domain.wireValueOf
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.Instant
import java.util.UUID

data class ApiKey(
    val id: UUID,
    val name: String,
    val role: Role,
    val ownerId: UUID?,
    val createdAt: Instant,
    val revokedAt: Instant?
)

/** A newly created key together with its secret, which is never stored. */
data class CreatedApiKey(val apiKey: ApiKey, val secret: String)

/** Authenticates API keys and manages them. */
@Service
class ApiKeyService(
    private val tx: Tx,
    private val jdbc: JdbcClient,
    private val ids: IdSource,
    private val clock: Clock
) {
    /** Returns the caller for an active key secret, or null when the secret is unknown or revoked. */
    fun authenticate(secret: String): Caller? =
        jdbc.sql("SELECT id, role, owner_id FROM api_keys WHERE key_hash = :hash AND revoked_at IS NULL")
            .param("hash", Hashing.sha256Hex(secret))
            .query { rs, _ -> Caller(rs.uuid("id"), wireValueOf<Role>(rs.getString("role")), rs.uuidOrNull("owner_id")) }
            .optional()
            .orElse(null)

    /** Creates a key and returns it with its secret. */
    fun create(caller: Caller, name: String, role: Role, ownerId: UUID?): CreatedApiKey {
        caller.require(Role.OPERATOR)
        if (role == Role.MERCHANT && ownerId == null) throw validationFailed("ownerId", "is required for merchant keys")
        if (role != Role.MERCHANT && ownerId != null) throw validationFailed("ownerId", "is only allowed for merchant keys")
        val secret = ids.apiKeySecret()
        val key = ApiKey(ids.uuid(), name, role, ownerId, clock.instant(), null)
        tx.inTx {
            jdbc.sql(
                """
                INSERT INTO api_keys (id, name, key_hash, role, owner_id, created_at)
                VALUES (:id, :name, :keyHash, :role, :ownerId, :createdAt)
                """.trimIndent()
            )
                .param("id", key.id)
                .param("name", key.name)
                .param("keyHash", Hashing.sha256Hex(secret))
                .param("role", key.role.wire)
                .param("ownerId", key.ownerId)
                .param("createdAt", key.createdAt.toDb())
                .update()
        }
        return CreatedApiKey(key, secret)
    }

    /** Revokes a key; revoking an already revoked key leaves it unchanged. */
    fun revoke(caller: Caller, id: UUID): ApiKey {
        caller.require(Role.OPERATOR)
        return tx.inTx {
            jdbc.sql("UPDATE api_keys SET revoked_at = :now WHERE id = :id AND revoked_at IS NULL")
                .param("now", clock.instant().toDb())
                .param("id", id)
                .update()
            find(id) ?: throw NotFoundException("API key $id was not found.")
        }
    }

    fun find(id: UUID): ApiKey? =
        jdbc.sql("SELECT id, name, role, owner_id, created_at, revoked_at FROM api_keys WHERE id = :id")
            .param("id", id)
            .query(MAPPER)
            .optional()
            .orElse(null)

    private companion object {
        val MAPPER = RowMapper { rs, _ ->
            ApiKey(
                id = rs.uuid("id"),
                name = rs.getString("name"),
                role = wireValueOf<Role>(rs.getString("role")),
                ownerId = rs.uuidOrNull("owner_id"),
                createdAt = rs.instant("created_at"),
                revokedAt = rs.instantOrNull("revoked_at")
            )
        }
    }
}
