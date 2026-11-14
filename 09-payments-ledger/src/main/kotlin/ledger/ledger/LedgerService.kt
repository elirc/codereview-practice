package ledger.ledger

import ledger.config.IdSource
import ledger.config.PgErrors
import ledger.config.RequestIds
import ledger.config.toDb
import ledger.domain.AccountStatus
import ledger.domain.ConflictException
import ledger.domain.Currency
import ledger.domain.EntryKind
import ledger.domain.EntryRules
import ledger.domain.Errors
import ledger.domain.PostingLine
import ledger.outbox.CauseType
import ledger.outbox.LedgerEvents
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.time.Clock
import java.time.Instant
import java.util.UUID

/** A journal entry to be posted. */
data class NewEntry(
    val kind: EntryKind,
    val lines: List<PostingLine>,
    val actorKeyId: UUID?,
    val id: UUID? = null,
    val reversesEntryId: UUID? = null,
    val reason: String? = null
)

data class Posting(val lineNo: Int, val accountId: UUID, val amountMinor: Long, val currency: Currency)

/** A posted journal entry with its postings. */
data class JournalEntry(
    val id: UUID,
    val sequence: Long,
    val kind: EntryKind,
    val reversesEntryId: UUID?,
    val reason: String?,
    val actorKeyId: UUID?,
    val requestId: String,
    val createdAt: Instant,
    val postings: List<Posting>
)

/** Posts journal entries and keeps account balances in step with them. */
@Service
class LedgerService(
    private val jdbc: JdbcClient,
    private val balances: BalanceStore,
    private val events: LedgerEvents,
    private val ids: IdSource,
    private val clock: Clock
) {
    /**
     * Posts [entry] in the caller's transaction and returns the stored entry.
     * [locks] supplies balance rows the caller already holds; [heldDeltas] changes `heldMinor` of those accounts.
     */
    fun post(entry: NewEntry, locks: LockSet? = null, heldDeltas: Map<UUID, Long> = emptyMap()): JournalEntry {
        check(TransactionSynchronizationManager.isActualTransactionActive()) { "post must run inside a transaction" }
        EntryRules.validate(entry.lines)

        val accountIds = entry.lines.map { it.accountId }.toSet() + heldDeltas.keys
        val locked = if (locks != null) {
            check(locks.containsAll(accountIds)) { "lock set does not cover every account of the entry" }
            locks
        } else {
            balances.lock(accountIds)
        }

        entry.lines.forEach { line -> checkLine(entry.kind, line, locked[line.accountId].account) }

        val postedDeltas = entry.lines.groupBy { it.accountId }
            .mapValues { (_, lines) -> lines.fold(0L) { acc, line -> Math.addExact(acc, line.amountMinor) } }
        val changes = accountIds.map { id ->
            BalanceChange(id, postedDeltas[id] ?: 0L, heldDeltas[id] ?: 0L)
        }
        changes.forEach { change -> checkAvailable(locked[change.accountId], change) }

        val createdAt = clock.instant()
        val entryId = entry.id ?: ids.uuid()
        val requestId = RequestIds.current()
        val sequence = insertEntry(entryId, entry, requestId, createdAt)
        val postings = entry.lines.mapIndexed { index, line ->
            Posting(index + 1, line.accountId, line.amountMinor, line.currency)
        }
        postings.forEach { insertPosting(entryId, it) }

        val posted = JournalEntry(
            id = entryId,
            sequence = sequence,
            kind = entry.kind,
            reversesEntryId = entry.reversesEntryId,
            reason = entry.reason,
            actorKeyId = entry.actorKeyId,
            requestId = requestId,
            createdAt = createdAt,
            postings = postings
        )
        events.entryPosted(posted)

        changes.forEach { change ->
            val current = locked[change.accountId]
            val updated = balances.apply(change.accountId, change.postedDelta, change.heldDelta, current.balance.availableMinor)
            events.balanceChanged(current.account, updated, CauseType.ENTRY, entryId, createdAt)
        }
        return posted
    }

    private data class BalanceChange(val accountId: UUID, val postedDelta: Long, val heldDelta: Long)

    private fun checkLine(kind: EntryKind, line: PostingLine, account: Account) {
        if (account.currency != line.currency) {
            throw Errors.currencyMismatch("Posting in ${line.currency} does not match account ${account.id} in ${account.currency}.")
        }
        when (account.status) {
            AccountStatus.CLOSED -> throw Errors.accountClosed(account.id)
            AccountStatus.FROZEN ->
                if (line.amountMinor < 0 && kind != EntryKind.CAPTURE && kind != EntryKind.REVERSAL) {
                    throw Errors.accountFrozen(account.id)
                }
            AccountStatus.ACTIVE -> Unit
        }
    }

    private fun checkAvailable(current: LockedAccount, change: BalanceChange) {
        if (current.account.allowNegative) return
        val before = current.balance.availableMinor
        val after = Math.subtractExact(
            Math.addExact(current.balance.postedMinor, change.postedDelta),
            Math.addExact(current.balance.heldMinor, change.heldDelta)
        )
        if (after < 0 && after < before) throw Errors.insufficientFunds(current.account.id, before)
    }

    private fun insertEntry(entryId: UUID, entry: NewEntry, requestId: String, createdAt: Instant): Long {
        try {
            return jdbc.sql(
                """
                INSERT INTO journal_entries (id, kind, reverses_entry_id, reason, actor_key_id, request_id, created_at)
                VALUES (:id, :kind, :reversesEntryId, :reason, :actorKeyId, :requestId, :createdAt)
                RETURNING sequence
                """.trimIndent()
            )
                .param("id", entryId)
                .param("kind", entry.kind.wire)
                .param("reversesEntryId", entry.reversesEntryId)
                .param("reason", entry.reason)
                .param("actorKeyId", entry.actorKeyId)
                .param("requestId", requestId)
                .param("createdAt", createdAt.toDb())
                .query { rs, _ -> rs.getLong("sequence") }
                .single()
        } catch (e: DataIntegrityViolationException) {
            if (PgErrors.isConstraint(e, "journal_entries_reverses_entry_id_key")) {
                throw ConflictException(
                    "already_reversed",
                    "Entry ${entry.reversesEntryId} has already been reversed.",
                    mapOf("entryId" to entry.reversesEntryId)
                )
            }
            throw e
        }
    }

    private fun insertPosting(entryId: UUID, posting: Posting) {
        jdbc.sql(
            """
            INSERT INTO postings (entry_id, line_no, account_id, amount_minor, currency)
            VALUES (:entryId, :lineNo, :accountId, :amountMinor, :currency)
            """.trimIndent()
        )
            .param("entryId", entryId)
            .param("lineNo", posting.lineNo)
            .param("accountId", posting.accountId)
            .param("amountMinor", posting.amountMinor)
            .param("currency", posting.currency.name)
            .update()
    }
}
