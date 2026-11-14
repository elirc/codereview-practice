package ledger.outbox

import com.fasterxml.jackson.annotation.JsonValue
import ledger.domain.WireValue
import ledger.ledger.Account
import ledger.ledger.BalanceRow
import ledger.ledger.JournalEntry
import org.springframework.stereotype.Component
import java.time.Instant
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
}
