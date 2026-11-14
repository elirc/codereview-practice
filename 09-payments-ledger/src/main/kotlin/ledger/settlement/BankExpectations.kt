package ledger.settlement

import com.fasterxml.jackson.annotation.JsonValue
import ledger.config.IdSource
import ledger.config.instant
import ledger.config.toDb
import ledger.config.uuid
import ledger.config.uuidOrNull
import ledger.domain.Currency
import ledger.domain.WireValue
import ledger.domain.wireValueOf
import ledger.outbox.LedgerEvents
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import java.time.Instant
import java.util.UUID

enum class ExpectationKind(@get:JsonValue override val wire: String) : WireValue {
    WITHDRAWAL("withdrawal"),
    PAYOUT("payout")
}

enum class ExpectationStatus(@get:JsonValue override val wire: String) : WireValue {
    OPEN("open"),
    MATCHED("matched"),
    RETURNED("returned"),
    CANCELLED("cancelled")
}

/** Money the ledger has sent towards the bank and expects to see leave the bank account. */
data class BankExpectation(
    val id: UUID,
    val kind: ExpectationKind,
    val reference: String,
    val accountId: UUID,
    val amountMinor: Long,
    val currency: Currency,
    val sourceEntryId: UUID,
    val status: ExpectationStatus,
    val matchedLineId: UUID?,
    val createdAt: Instant,
    val updatedAt: Instant
)

/** Reads and writes `bank_expectations` and records the payout events. */
@Component
class BankExpectations(
    private val jdbc: JdbcClient,
    private val events: LedgerEvents,
    private val ids: IdSource
) {
    /** Creates an open expectation and records `payout.created`. */
    fun create(
        kind: ExpectationKind,
        reference: String,
        accountId: UUID,
        amountMinor: Long,
        currency: Currency,
        sourceEntryId: UUID,
        at: Instant
    ): BankExpectation {
        val expectation = BankExpectation(
            id = ids.uuid(),
            kind = kind,
            reference = reference,
            accountId = accountId,
            amountMinor = amountMinor,
            currency = currency,
            sourceEntryId = sourceEntryId,
            status = ExpectationStatus.OPEN,
            matchedLineId = null,
            createdAt = at,
            updatedAt = at
        )
        jdbc.sql(
            """
            INSERT INTO bank_expectations (id, kind, reference, account_id, amount_minor, currency, source_entry_id,
                                           status, created_at, updated_at)
            VALUES (:id, :kind, :reference, :accountId, :amountMinor, :currency, :sourceEntryId, 'open', :at, :at)
            """.trimIndent()
        )
            .param("id", expectation.id)
            .param("kind", kind.wire)
            .param("reference", reference)
            .param("accountId", accountId)
            .param("amountMinor", amountMinor)
            .param("currency", currency.name)
            .param("sourceEntryId", sourceEntryId)
            .param("at", at.toDb())
            .update()
        events.payout(PAYOUT_CREATED, expectation, CREATED_SEQUENCE, at)
        return expectation
    }

    fun find(id: UUID): BankExpectation? =
        jdbc.sql("SELECT * FROM bank_expectations WHERE id = :id")
            .param("id", id)
            .query(MAPPER)
            .optional()
            .orElse(null)

    /** Locks and returns the expectation created by entry [entryId], if any. */
    fun lockBySourceEntry(entryId: UUID): BankExpectation? =
        jdbc.sql("SELECT * FROM bank_expectations WHERE source_entry_id = :entryId FOR UPDATE")
            .param("entryId", entryId)
            .query(MAPPER)
            .optional()
            .orElse(null)

    /** Locks and returns the expectation with [reference], if any. */
    fun lockByReference(reference: String): BankExpectation? =
        jdbc.sql("SELECT * FROM bank_expectations WHERE reference = :reference FOR UPDATE")
            .param("reference", reference)
            .query(MAPPER)
            .optional()
            .orElse(null)

    /**
     * Moves the expectation from [from] to [to] and returns true, or returns false when it is no longer in [from].
     * Records `payout.matched` or `payout.returned` for those transitions.
     */
    fun transition(
        expectation: BankExpectation,
        from: ExpectationStatus,
        to: ExpectationStatus,
        at: Instant,
        matchedLineId: UUID? = null
    ): Boolean {
        val updated = jdbc.sql(
            """
            UPDATE bank_expectations
            SET status = :to, updated_at = :at, matched_line_id = COALESCE(:matchedLineId, matched_line_id)
            WHERE id = :id AND status = :from
            """.trimIndent()
        )
            .param("to", to.wire)
            .param("at", at.toDb())
            .param("matchedLineId", matchedLineId)
            .param("id", expectation.id)
            .param("from", from.wire)
            .update()
        if (updated == 0) return false
        val changed = expectation.copy(status = to, updatedAt = at, matchedLineId = matchedLineId ?: expectation.matchedLineId)
        when (to) {
            ExpectationStatus.MATCHED -> events.payout(PAYOUT_MATCHED, changed, MATCHED_SEQUENCE, at)
            ExpectationStatus.RETURNED -> events.payout(PAYOUT_RETURNED, changed, RETURNED_SEQUENCE, at)
            else -> Unit
        }
        return true
    }

    /** True when the account has an open expectation. */
    fun hasOpenFor(accountId: UUID): Boolean =
        jdbc.sql("SELECT EXISTS (SELECT 1 FROM bank_expectations WHERE account_id = :accountId AND status = 'open')")
            .param("accountId", accountId)
            .query(Boolean::class.javaObjectType)
            .single()

    companion object {
        const val PAYOUT_CREATED = "payout.created"
        const val PAYOUT_MATCHED = "payout.matched"
        const val PAYOUT_RETURNED = "payout.returned"
        private const val CREATED_SEQUENCE = 1L
        private const val MATCHED_SEQUENCE = 2L
        private const val RETURNED_SEQUENCE = 3L

        val MAPPER = RowMapper { rs, _ ->
            BankExpectation(
                id = rs.uuid("id"),
                kind = wireValueOf<ExpectationKind>(rs.getString("kind")),
                reference = rs.getString("reference"),
                accountId = rs.uuid("account_id"),
                amountMinor = rs.getLong("amount_minor"),
                currency = Currency.fromDb(rs.getString("currency")),
                sourceEntryId = rs.uuid("source_entry_id"),
                status = wireValueOf<ExpectationStatus>(rs.getString("status")),
                matchedLineId = rs.uuidOrNull("matched_line_id"),
                createdAt = rs.instant("created_at"),
                updatedAt = rs.instant("updated_at")
            )
        }
    }
}
