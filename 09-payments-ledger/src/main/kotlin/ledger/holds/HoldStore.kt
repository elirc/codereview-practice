package ledger.holds

import com.fasterxml.jackson.annotation.JsonValue
import ledger.config.instant
import ledger.config.localDate
import ledger.config.toDb
import ledger.config.uuid
import ledger.config.uuidOrNull
import ledger.domain.Currency
import ledger.domain.WireValue
import ledger.domain.wireValueOf
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

enum class HoldStatus(@get:JsonValue override val wire: String) : WireValue {
    ACTIVE("active"),
    CAPTURED("captured"),
    RELEASED("released"),
    EXPIRED("expired")
}

/** An authorisation hold on a customer wallet in favour of a merchant account. */
data class Hold(
    val id: UUID,
    val accountId: UUID,
    val merchantAccountId: UUID,
    val amountMinor: Long,
    val capturedMinor: Long,
    val currency: Currency,
    val status: HoldStatus,
    val expiresAt: Instant,
    val authorizedOn: LocalDate,
    val captureEntryId: UUID?,
    val version: Long,
    val createdAt: Instant,
    val updatedAt: Instant
)

/** Reads and writes rows of the `holds` table. */
@Component
class HoldStore(private val jdbc: JdbcClient) {
    fun insert(hold: Hold) {
        jdbc.sql(
            """
            INSERT INTO holds (id, account_id, merchant_account_id, amount_minor, captured_minor, currency, status,
                               expires_at, authorized_on, capture_entry_id, version, created_at, updated_at)
            VALUES (:id, :accountId, :merchantAccountId, :amountMinor, :capturedMinor, :currency, :status,
                    :expiresAt, :authorizedOn, :captureEntryId, :version, :createdAt, :updatedAt)
            """.trimIndent()
        )
            .param("id", hold.id)
            .param("accountId", hold.accountId)
            .param("merchantAccountId", hold.merchantAccountId)
            .param("amountMinor", hold.amountMinor)
            .param("capturedMinor", hold.capturedMinor)
            .param("currency", hold.currency.name)
            .param("status", hold.status.wire)
            .param("expiresAt", hold.expiresAt.toDb())
            .param("authorizedOn", hold.authorizedOn)
            .param("captureEntryId", hold.captureEntryId)
            .param("version", hold.version)
            .param("createdAt", hold.createdAt.toDb())
            .param("updatedAt", hold.updatedAt.toDb())
            .update()
    }

    fun find(id: UUID): Hold? =
        jdbc.sql("SELECT * FROM holds WHERE id = :id")
            .param("id", id)
            .query(MAPPER)
            .optional()
            .orElse(null)

    /** Locks and returns the hold row. */
    fun lock(id: UUID): Hold? =
        jdbc.sql("SELECT * FROM holds WHERE id = :id FOR UPDATE")
            .param("id", id)
            .query(MAPPER)
            .optional()
            .orElse(null)

    /** Writes the mutable fields of a locked hold. */
    fun update(hold: Hold) {
        jdbc.sql(
            """
            UPDATE holds
            SET status = :status, captured_minor = :capturedMinor, capture_entry_id = :captureEntryId,
                version = :version, updated_at = :updatedAt
            WHERE id = :id
            """.trimIndent()
        )
            .param("status", hold.status.wire)
            .param("capturedMinor", hold.capturedMinor)
            .param("captureEntryId", hold.captureEntryId)
            .param("version", hold.version)
            .param("updatedAt", hold.updatedAt.toDb())
            .param("id", hold.id)
            .update()
    }

    /** Returns ids of active holds whose expiry is at or before [now], oldest first. */
    fun expiredIds(now: Instant, limit: Int): List<UUID> =
        jdbc.sql("SELECT id FROM holds WHERE status = 'active' AND expires_at <= :now ORDER BY expires_at, id LIMIT :limit")
            .param("now", now.toDb())
            .param("limit", limit)
            .query { rs, _ -> rs.uuid("id") }
            .list()

    private companion object {
        val MAPPER = RowMapper { rs, _ ->
            Hold(
                id = rs.uuid("id"),
                accountId = rs.uuid("account_id"),
                merchantAccountId = rs.uuid("merchant_account_id"),
                amountMinor = rs.getLong("amount_minor"),
                capturedMinor = rs.getLong("captured_minor"),
                currency = Currency.fromDb(rs.getString("currency")),
                status = wireValueOf<HoldStatus>(rs.getString("status")),
                expiresAt = rs.instant("expires_at"),
                authorizedOn = rs.localDate("authorized_on"),
                captureEntryId = rs.uuidOrNull("capture_entry_id"),
                version = rs.getLong("version"),
                createdAt = rs.instant("created_at"),
                updatedAt = rs.instant("updated_at")
            )
        }
    }
}
