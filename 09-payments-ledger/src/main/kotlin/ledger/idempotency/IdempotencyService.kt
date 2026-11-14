package ledger.idempotency

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import ledger.api.ErrorEnvelope
import ledger.config.Tx
import ledger.config.intOrNull
import ledger.config.toDb
import ledger.domain.BadRequestException
import ledger.domain.BusinessRuleException
import ledger.domain.Caller
import ledger.domain.ConflictException
import ledger.domain.DomainException
import org.springframework.http.ResponseEntity
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import java.time.Clock
import java.util.UUID

/** The outcome of an operation run under an idempotency key: HTTP status and response body. */
data class ApiResult(val status: Int, val body: Any)

/** Runs POST operations at most once per API key and `Idempotency-Key`, returning the stored response on repeats. */
@Service
class IdempotencyService(
    private val tx: Tx,
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
    private val clock: Clock
) {
    /**
     * Runs [operation] in one transaction together with the key bookkeeping and returns its response.
     * A repeat with the same fingerprint returns the stored response with `Idempotent-Replay: true`.
     */
    fun execute(caller: Caller, rawKey: String?, fingerprint: String, operation: () -> ApiResult): ResponseEntity<JsonNode> {
        val key = validKey(rawKey)
        var failure: DomainException? = null
        val response = tx.inTxWithStatus { status ->
            if (!insert(caller.keyId, key, fingerprint)) {
                return@inTxWithStatus replay(caller.keyId, key, fingerprint)
            }
            val savepoint = status.createSavepoint()
            try {
                val result = operation()
                status.releaseSavepoint(savepoint)
                val body = toJson(result.body)
                complete(caller.keyId, key, result.status, body)
                ResponseEntity.status(result.status).body(body)
            } catch (e: DomainException) {
                if (e.status !in STORED_ERROR_STATUSES) throw e
                status.rollbackToSavepoint(savepoint)
                complete(caller.keyId, key, e.status, toJson(ErrorEnvelope.of(e)))
                failure = e
                null
            }
        }
        failure?.let { throw it }
        return checkNotNull(response)
    }

    /**
     * Runs [operation], which manages its own transactions, under the key: the key is recorded first,
     * the operation runs, and its response is stored afterwards.
     */
    fun executeInSteps(caller: Caller, rawKey: String?, fingerprint: String, operation: () -> ApiResult): ResponseEntity<JsonNode> {
        val key = validKey(rawKey)
        val claimed = tx.inTx { insert(caller.keyId, key, fingerprint) }
        if (!claimed) return tx.inTx { replay(caller.keyId, key, fingerprint) }
        val result = try {
            operation()
        } catch (e: DomainException) {
            if (e.status in STORED_ERROR_STATUSES) {
                tx.inTx { complete(caller.keyId, key, e.status, toJson(ErrorEnvelope.of(e))) }
            } else {
                tx.inTx { remove(caller.keyId, key) }
            }
            throw e
        } catch (e: Exception) {
            tx.inTx { remove(caller.keyId, key) }
            throw e
        }
        val body = toJson(result.body)
        tx.inTx { complete(caller.keyId, key, result.status, body) }
        return ResponseEntity.status(result.status).body(body)
    }

    /** Renders [value] as the JSON tree a stored response is read back as. */
    private fun toJson(value: Any): JsonNode = mapper.readTree(mapper.writeValueAsString(value))

    private fun validKey(rawKey: String?): String {
        if (rawKey == null || !KEY_PATTERN.matches(rawKey)) {
            throw BadRequestException(
                "idempotency_key_required",
                "An Idempotency-Key header of 8 to 128 visible ASCII characters is required."
            )
        }
        return rawKey
    }

    private fun insert(apiKeyId: UUID, key: String, fingerprint: String): Boolean =
        jdbc.sql(
            """
            INSERT INTO idempotency_keys (api_key_id, key, fingerprint, state, created_at)
            VALUES (:apiKeyId, :key, :fingerprint, 'in_progress', :createdAt)
            ON CONFLICT (api_key_id, key) DO NOTHING
            """.trimIndent()
        )
            .param("apiKeyId", apiKeyId)
            .param("key", key)
            .param("fingerprint", fingerprint)
            .param("createdAt", clock.instant().toDb())
            .update() == 1

    private fun replay(apiKeyId: UUID, key: String, fingerprint: String): ResponseEntity<JsonNode> {
        val stored = jdbc.sql(
            """
            SELECT fingerprint, state, response_status, response_body::text AS response_body
            FROM idempotency_keys
            WHERE api_key_id = :apiKeyId AND key = :key
            """.trimIndent()
        )
            .param("apiKeyId", apiKeyId)
            .param("key", key)
            .query { rs, _ ->
                StoredKey(rs.getString("fingerprint"), rs.getString("state"), rs.intOrNull("response_status"), rs.getString("response_body"))
            }
            .optional()
            .orElse(null)
            ?: throw ConflictException("invalid_state", "The request with this Idempotency-Key did not finish; retry it.")
        if (stored.fingerprint != fingerprint) {
            throw BusinessRuleException(
                "idempotency_key_reused",
                "This Idempotency-Key was already used for a different request."
            )
        }
        if (stored.state != COMPLETED || stored.responseStatus == null || stored.responseBody == null) {
            throw ConflictException("invalid_state", "The request with this Idempotency-Key is still being processed.")
        }
        return ResponseEntity.status(stored.responseStatus)
            .header(REPLAY_HEADER, "true")
            .body(mapper.readTree(stored.responseBody))
    }

    private fun complete(apiKeyId: UUID, key: String, status: Int, body: JsonNode) {
        jdbc.sql(
            """
            UPDATE idempotency_keys
            SET state = 'completed', response_status = :status, response_body = CAST(:body AS jsonb)
            WHERE api_key_id = :apiKeyId AND key = :key
            """.trimIndent()
        )
            .param("status", status)
            .param("body", mapper.writeValueAsString(body))
            .param("apiKeyId", apiKeyId)
            .param("key", key)
            .update()
    }

    private fun remove(apiKeyId: UUID, key: String) {
        jdbc.sql("DELETE FROM idempotency_keys WHERE api_key_id = :apiKeyId AND key = :key AND state = 'in_progress'")
            .param("apiKeyId", apiKeyId)
            .param("key", key)
            .update()
    }

    private data class StoredKey(val fingerprint: String, val state: String, val responseStatus: Int?, val responseBody: String?)

    companion object {
        const val HEADER = "Idempotency-Key"
        const val REPLAY_HEADER = "Idempotent-Replay"
        private const val COMPLETED = "completed"
        private val STORED_ERROR_STATUSES = setOf(403, 404, 409, 422)
        private val KEY_PATTERN = Regex("^[\\x21-\\x7E]{8,128}$")
    }
}
