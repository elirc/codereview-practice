package ledger.outbox

import com.fasterxml.jackson.annotation.JsonValue
import ledger.domain.AccountStatus
import ledger.domain.Currency
import ledger.domain.WireValue
import ledger.holds.Hold
import ledger.ledger.Account
import ledger.ledger.BalanceRow
import ledger.ledger.JournalEntry
import ledger.settlement.BankExpectation
import org.springframework.stereotype.Component
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

enum class CauseType(@get:JsonValue override val wire: String) : WireValue {
    ENTRY("entry"),
    HOLD("hold")
}

/** Writes the ledger's domain events to the outbox. */
@Component
class LedgerEvents(private val outbox: OutboxWriter) {
    fun entryPosted(entry: JournalEntry) {
        outbox.record(
            topic = Topics.ENTRIES,
            partitionKey = entry.id.toString(),
            type = "entry.posted",
            aggregateType = "journal_entry",
            aggregateId = entry.id.toString(),
            sequence = entry.sequence,
            occurredAt = entry.createdAt,
            data = mapOf(
                "entryId" to entry.id,
                "kind" to entry.kind,
                "reversesEntryId" to entry.reversesEntryId,
                "postings" to entry.postings.map { posting ->
                    mapOf(
                        "lineNo" to posting.lineNo,
                        "accountId" to posting.accountId,
                        "amountMinor" to posting.amountMinor,
                        "currency" to posting.currency
                    )
                }
            )
        )
    }

    fun balanceChanged(account: Account, balance: BalanceRow, causeType: CauseType, causeId: UUID, occurredAt: Instant) {
        outbox.record(
            topic = Topics.ACCOUNTS,
            partitionKey = account.id.toString(),
            type = "account.balance_changed",
            aggregateType = "account",
            aggregateId = account.id.toString(),
            sequence = balance.version,
            occurredAt = occurredAt,
            data = mapOf(
                "accountId" to account.id,
                "currency" to account.currency,
                "postedMinor" to balance.postedMinor,
                "heldMinor" to balance.heldMinor,
                "availableMinor" to balance.availableMinor,
                "causeType" to causeType,
                "causeId" to causeId
            )
        )
    }

    fun statusChanged(account: Account, previous: AccountStatus, version: Long, occurredAt: Instant) {
        outbox.record(
            topic = Topics.ACCOUNTS,
            partitionKey = account.id.toString(),
            type = "account.status_changed",
            aggregateType = "account",
            aggregateId = account.id.toString(),
            sequence = version,
            occurredAt = occurredAt,
            data = mapOf(
                "accountId" to account.id,
                "status" to account.status,
                "previousStatus" to previous
            )
        )
    }

    fun payout(type: String, expectation: BankExpectation, sequence: Long, occurredAt: Instant) {
        outbox.record(
            topic = Topics.SETTLEMENT,
            partitionKey = expectation.accountId.toString(),
            type = type,
            aggregateType = "bank_expectation",
            aggregateId = expectation.id.toString(),
            sequence = sequence,
            occurredAt = occurredAt,
            data = mapOf(
                "expectationId" to expectation.id,
                "kind" to expectation.kind,
                "reference" to expectation.reference,
                "accountId" to expectation.accountId,
                "amountMinor" to expectation.amountMinor,
                "currency" to expectation.currency
            )
        )
    }

    fun hold(type: String, hold: Hold, occurredAt: Instant) {
        outbox.record(
            topic = Topics.ACCOUNTS,
            partitionKey = hold.accountId.toString(),
            type = type,
            aggregateType = "hold",
            aggregateId = hold.id.toString(),
            sequence = hold.version,
            occurredAt = occurredAt,
            data = mapOf(
                "holdId" to hold.id,
                "accountId" to hold.accountId,
                "merchantAccountId" to hold.merchantAccountId,
                "amountMinor" to hold.amountMinor,
                "capturedMinor" to hold.capturedMinor,
                "currency" to hold.currency,
                "expiresAt" to hold.expiresAt,
                "captureEntryId" to hold.captureEntryId
            )
        )
    }

    fun settlementCompleted(
        batchId: UUID,
        businessDate: LocalDate,
        currency: Currency,
        paidCount: Long,
        paidTotalMinor: Long,
        occurredAt: Instant
    ) {
        outbox.record(
            topic = Topics.SETTLEMENT,
            partitionKey = batchId.toString(),
            type = "settlement.batch_completed",
            aggregateType = "settlement_batch",
            aggregateId = batchId.toString(),
            sequence = 1,
            occurredAt = occurredAt,
            data = mapOf(
                "batchId" to batchId,
                "businessDate" to businessDate,
                "currency" to currency,
                "paidCount" to paidCount,
                "paidTotalMinor" to paidTotalMinor
            )
        )
    }

    fun discrepancyFound(
        statementId: UUID,
        lineId: UUID,
        lineNo: Int,
        reference: String,
        lineAmountMinor: Long,
        expectedAmountMinor: Long,
        currency: Currency,
        occurredAt: Instant
    ) {
        outbox.record(
            topic = Topics.SETTLEMENT,
            partitionKey = statementId.toString(),
            type = "reconciliation.discrepancy_found",
            aggregateType = "statement",
            aggregateId = statementId.toString(),
            sequence = lineNo.toLong(),
            occurredAt = occurredAt,
            data = mapOf(
                "statementId" to statementId,
                "lineId" to lineId,
                "reference" to reference,
                "lineAmountMinor" to lineAmountMinor,
                "expectedAmountMinor" to expectedAmountMinor,
                "currency" to currency
            )
        )
    }
}
