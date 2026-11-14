package ledger.settlement

import com.fasterxml.jackson.annotation.JsonValue
import ledger.config.IdSource
import ledger.config.LedgerProperties
import ledger.config.Tx
import ledger.config.instant
import ledger.config.instantOrNull
import ledger.config.localDate
import ledger.config.toDb
import ledger.config.uuid
import ledger.config.uuidOrNull
import ledger.domain.BusinessRuleException
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.domain.EntryKind
import ledger.domain.NotFoundException
import ledger.domain.Payouts
import ledger.domain.PostingLine
import ledger.domain.Role
import ledger.domain.SettlementOutcome
import ledger.domain.SystemRole
import ledger.domain.WireValue
import ledger.domain.startOfUtcDay
import ledger.domain.wireValueOf
import ledger.ledger.Accounts
import ledger.ledger.BalanceStore
import ledger.ledger.LedgerService
import ledger.ledger.NewEntry
import ledger.outbox.LedgerEvents
import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.UUID

enum class BatchStatus(@get:JsonValue override val wire: String) : WireValue {
    PROCESSING("processing"),
    COMPLETED("completed")
}

data class SettlementBatch(
    val id: UUID,
    val businessDate: LocalDate,
    val currency: Currency,
    val status: BatchStatus,
    val cutoffAt: Instant,
    val createdAt: Instant,
    val completedAt: Instant?
)

data class SettlementItem(
    val merchantAccountId: UUID,
    val outcome: SettlementOutcome,
    val amountMinor: Long,
    val entryId: UUID?,
    val expectationId: UUID?,
    val createdAt: Instant
)

/** A batch with its items. */
data class SettlementView(val batch: SettlementBatch, val items: List<SettlementItem>)

/** End-of-day settlement: pays merchant balances out to the bank through payout clearing. */
@Service
class SettlementService(
    private val tx: Tx,
    private val jdbc: JdbcClient,
    private val accounts: Accounts,
    private val balances: BalanceStore,
    private val ledger: LedgerService,
    private val expectations: BankExpectations,
    private val events: LedgerEvents,
    private val properties: LedgerProperties,
    private val ids: IdSource,
    private val clock: Clock
) {
    private val log = LoggerFactory.getLogger(javaClass)

    /** Runs settlement for [businessDate] and [currency] on behalf of an operator and returns the batch. */
    fun run(caller: Caller, businessDate: LocalDate, currency: Currency): SettlementView {
        caller.require(Role.OPERATOR)
        return run(businessDate, currency, clock.instant(), caller.keyId)
    }

    /**
     * Creates or resumes the batch for [businessDate] and [currency], settles every merchant account without an
     * item, each in its own transaction, and completes the batch once every merchant account has an item.
     */
    fun run(businessDate: LocalDate, currency: Currency, now: Instant, actorKeyId: UUID?): SettlementView {
        val cutoff = startOfUtcDay(businessDate.plusDays(1))
        if (now.isBefore(cutoff)) {
            throw BusinessRuleException(
                "settlement_too_early",
                "Settlement for $businessDate can run from $cutoff.",
                mapOf("cutoffAt" to cutoff)
            )
        }
        val batch = tx.inTx { insertOrLoad(businessDate, currency, cutoff, now) }
        if (batch.status == BatchStatus.COMPLETED) return view(batch)

        accounts.merchantIds(currency).forEach { merchantId ->
            try {
                tx.inTx { settleMerchant(batch, merchantId, actorKeyId) }
            } catch (e: Exception) {
                log.atError().setCause(e).addKeyValue("batchId", batch.id).addKeyValue("merchantAccountId", merchantId)
                    .log("Settling a merchant account failed")
            }
        }
        tx.inTx { completeIfDone(batch) }
        return view(find(batch.id)!!)
    }

    /** Returns a batch with its items. */
    fun get(caller: Caller, id: UUID): SettlementView {
        caller.require(Role.OPERATOR, Role.AUDITOR)
        val batch = find(id) ?: throw NotFoundException("Settlement $id was not found.")
        return view(batch)
    }

    /** Returns the business date and currency of batches still processing for dates before [before]. */
    fun unfinishedBefore(before: LocalDate): List<Pair<LocalDate, Currency>> =
        jdbc.sql(
            """
            SELECT business_date, currency FROM settlement_batches
            WHERE status = 'processing' AND business_date < :before
            ORDER BY business_date
            """.trimIndent()
        )
            .param("before", before)
            .query { rs, _ -> rs.localDate("business_date") to Currency.fromDb(rs.getString("currency")) }
            .list()

    private fun insertOrLoad(businessDate: LocalDate, currency: Currency, cutoff: Instant, now: Instant): SettlementBatch {
        jdbc.sql(
            """
            INSERT INTO settlement_batches (id, business_date, currency, status, cutoff_at, created_at)
            VALUES (:id, :businessDate, :currency, 'processing', :cutoff, :now)
            ON CONFLICT (business_date, currency) DO NOTHING
            """.trimIndent()
        )
            .param("id", ids.uuid())
            .param("businessDate", businessDate)
            .param("currency", currency.name)
            .param("cutoff", cutoff.toDb())
            .param("now", now.toDb())
            .update()
        return jdbc.sql("SELECT * FROM settlement_batches WHERE business_date = :businessDate AND currency = :currency")
            .param("businessDate", businessDate)
            .param("currency", currency.name)
            .query(BATCH)
            .single()
    }

    private fun settleMerchant(batch: SettlementBatch, merchantId: UUID, actorKeyId: UUID?) {
        val clearing = accounts.system(SystemRole.PAYOUT_CLEARING, batch.currency)
        val locks = balances.lock(listOf(merchantId, clearing.id))
        if (itemExists(batch.id, merchantId)) return

        val locked = locks[merchantId]
        val merchant = locked.account
        val asOf = balanceBefore(merchantId, batch.cutoffAt)
        val payable = Payouts.payable(asOf, locked.balance.availableMinor)
        val outcome = Payouts.outcome(merchant.payoutEnabled == true, merchant.status, payable, properties.minPayoutFor(batch.currency))
        if (outcome != SettlementOutcome.PAID) {
            insertItem(batch.id, merchantId, outcome, maxOf(0L, payable), null, null)
            return
        }
        val entry = ledger.post(
            NewEntry(
                kind = EntryKind.SETTLEMENT,
                lines = listOf(
                    PostingLine(merchantId, -payable, batch.currency),
                    PostingLine(clearing.id, payable, batch.currency)
                ),
                actorKeyId = actorKeyId
            ),
            locks = locks
        )
        val expectation = expectations.create(
            kind = ExpectationKind.PAYOUT,
            reference = payoutReference(batch.businessDate, merchantId),
            accountId = merchantId,
            amountMinor = payable,
            currency = batch.currency,
            sourceEntryId = entry.id,
            at = entry.createdAt
        )
        insertItem(batch.id, merchantId, outcome, payable, entry.id, expectation.id)
    }

    private fun completeIfDone(batch: SettlementBatch) {
        val missing = jdbc.sql(
            """
            SELECT count(*) FROM accounts a
            WHERE a.type = 'merchant' AND a.currency = :currency
              AND NOT EXISTS (
                  SELECT 1 FROM settlement_items i WHERE i.batch_id = :batchId AND i.merchant_account_id = a.id
              )
            """.trimIndent()
        )
            .param("currency", batch.currency.name)
            .param("batchId", batch.id)
            .query(Long::class.javaObjectType)
            .single()
        if (missing > 0) {
            log.atWarn().addKeyValue("batchId", batch.id).addKeyValue("missing", missing).log("Settlement batch left processing")
            return
        }
        val now = clock.instant()
        val completed = jdbc.sql(
            "UPDATE settlement_batches SET status = 'completed', completed_at = :now WHERE id = :id AND status = 'processing'"
        )
            .param("now", now.toDb())
            .param("id", batch.id)
            .update()
        if (completed == 0) return
        val totals = jdbc.sql(
            """
            SELECT count(*) AS paid_count, COALESCE(sum(amount_minor), 0) AS paid_total
            FROM settlement_items WHERE batch_id = :batchId AND outcome = 'paid'
            """.trimIndent()
        )
            .param("batchId", batch.id)
            .query { rs, _ -> rs.getLong("paid_count") to rs.getLong("paid_total") }
            .single()
        events.settlementCompleted(batch.id, batch.businessDate, batch.currency, totals.first, totals.second, now)
    }

    private fun itemExists(batchId: UUID, merchantId: UUID): Boolean =
        jdbc.sql("SELECT EXISTS (SELECT 1 FROM settlement_items WHERE batch_id = :batchId AND merchant_account_id = :merchantId)")
            .param("batchId", batchId)
            .param("merchantId", merchantId)
            .query(Boolean::class.javaObjectType)
            .single()

    /** Sum of the account's postings in entries created before [cutoff]. */
    private fun balanceBefore(accountId: UUID, cutoff: Instant): Long =
        jdbc.sql(
            """
            SELECT COALESCE(sum(p.amount_minor), 0)
            FROM postings p
            JOIN journal_entries e ON e.id = p.entry_id
            WHERE p.account_id = :accountId AND e.created_at < :cutoff
            """.trimIndent()
        )
            .param("accountId", accountId)
            .param("cutoff", cutoff.toDb())
            .query(Long::class.javaObjectType)
            .single()

    private fun insertItem(
        batchId: UUID,
        merchantId: UUID,
        outcome: SettlementOutcome,
        amountMinor: Long,
        entryId: UUID?,
        expectationId: UUID?
    ) {
        jdbc.sql(
            """
            INSERT INTO settlement_items (batch_id, merchant_account_id, outcome, amount_minor, entry_id, expectation_id, created_at)
            VALUES (:batchId, :merchantId, :outcome, :amountMinor, :entryId, :expectationId, :createdAt)
            """.trimIndent()
        )
            .param("batchId", batchId)
            .param("merchantId", merchantId)
            .param("outcome", outcome.wire)
            .param("amountMinor", amountMinor)
            .param("entryId", entryId)
            .param("expectationId", expectationId)
            .param("createdAt", clock.instant().toDb())
            .update()
    }

    private fun find(id: UUID): SettlementBatch? =
        jdbc.sql("SELECT * FROM settlement_batches WHERE id = :id")
            .param("id", id)
            .query(BATCH)
            .optional()
            .orElse(null)

    private fun view(batch: SettlementBatch): SettlementView {
        val items = jdbc.sql("SELECT * FROM settlement_items WHERE batch_id = :batchId ORDER BY merchant_account_id")
            .param("batchId", batch.id)
            .query { rs, _ ->
                SettlementItem(
                    merchantAccountId = rs.uuid("merchant_account_id"),
                    outcome = wireValueOf<SettlementOutcome>(rs.getString("outcome")),
                    amountMinor = rs.getLong("amount_minor"),
                    entryId = rs.uuidOrNull("entry_id"),
                    expectationId = rs.uuidOrNull("expectation_id"),
                    createdAt = rs.instant("created_at")
                )
            }
            .list()
        return SettlementView(batch, items)
    }

    companion object {
        private val REFERENCE_DATE: DateTimeFormatter = DateTimeFormatter.BASIC_ISO_DATE

        /** Returns `STL-<yyyyMMdd>-<first 12 hex digits of the account id>` in upper case. */
        fun payoutReference(businessDate: LocalDate, merchantId: UUID): String =
            "STL-" + businessDate.format(REFERENCE_DATE) + "-" + merchantId.toString().replace("-", "").take(12).uppercase()

        private val BATCH = RowMapper { rs, _ ->
            SettlementBatch(
                id = rs.uuid("id"),
                businessDate = rs.localDate("business_date"),
                currency = Currency.fromDb(rs.getString("currency")),
                status = wireValueOf<BatchStatus>(rs.getString("status")),
                cutoffAt = rs.instant("cutoff_at"),
                createdAt = rs.instant("created_at"),
                completedAt = rs.instantOrNull("completed_at")
            )
        }
    }
}
