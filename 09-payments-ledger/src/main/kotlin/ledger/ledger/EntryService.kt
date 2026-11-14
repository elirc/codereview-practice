package ledger.ledger

import ledger.config.Tx
import ledger.domain.BusinessRuleException
import ledger.domain.Caller
import ledger.domain.ConflictException
import ledger.domain.EntryKind
import ledger.domain.NotFoundException
import ledger.domain.PostingLine
import ledger.domain.Role
import ledger.settlement.BankExpectations
import ledger.settlement.ExpectationStatus
import org.springframework.stereotype.Service
import java.time.Clock
import java.util.UUID

/** Reads journal entries and reverses them. */
@Service
class EntryService(
    private val tx: Tx,
    private val entries: EntryQueries,
    private val ledger: LedgerService,
    private val expectations: BankExpectations,
    private val clock: Clock
) {
    /** Returns the entry with its postings. */
    fun get(caller: Caller, id: UUID): JournalEntry {
        caller.require(Role.OPERATOR, Role.AUDITOR)
        return entries.find(id) ?: throw entryNotFound(id)
    }

    /** Posts an entry that negates every posting of entry [id] and returns it. */
    fun reverse(caller: Caller, id: UUID, reason: String): JournalEntry {
        caller.require(Role.OPERATOR)
        return tx.inTx {
            val original = entries.find(id) ?: throw entryNotFound(id)
            if (original.kind !in REVERSIBLE_KINDS) throw notReversible(original)
            requireNotReversed(id)
            if (original.kind == EntryKind.WITHDRAWAL) {
                val expectation = expectations.lockBySourceEntry(id) ?: throw notReversible(original)
                requireNotReversed(id)
                if (expectation.status != ExpectationStatus.OPEN) throw notReversible(original)
                expectations.transition(expectation, ExpectationStatus.OPEN, ExpectationStatus.CANCELLED, clock.instant())
            }
            ledger.post(
                NewEntry(
                    kind = EntryKind.REVERSAL,
                    lines = original.postings.map { PostingLine(it.accountId, -it.amountMinor, it.currency) },
                    actorKeyId = caller.keyId,
                    reversesEntryId = id,
                    reason = reason
                )
            )
        }
    }

    private fun requireNotReversed(id: UUID) {
        if (entries.reversalOf(id) != null) {
            throw ConflictException("already_reversed", "Entry $id has already been reversed.", mapOf("entryId" to id))
        }
    }

    private fun notReversible(entry: JournalEntry) =
        BusinessRuleException(
            "not_reversible",
            "Entry ${entry.id} of kind ${entry.kind.wire} cannot be reversed.",
            mapOf("entryId" to entry.id, "kind" to entry.kind)
        )

    private fun entryNotFound(id: UUID) = NotFoundException("Entry $id was not found.")

    private companion object {
        val REVERSIBLE_KINDS = setOf(
            EntryKind.TRANSFER,
            EntryKind.CAPTURE,
            EntryKind.FX_TRANSFER,
            EntryKind.SUSPENSE,
            EntryKind.WITHDRAWAL
        )
    }
}
