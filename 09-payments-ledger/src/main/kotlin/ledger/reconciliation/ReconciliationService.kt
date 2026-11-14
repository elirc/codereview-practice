package ledger.reconciliation

import com.fasterxml.jackson.annotation.JsonValue
import ledger.config.Tx
import ledger.config.toDb
import ledger.config.uuid
import ledger.domain.AccountStatus
import ledger.domain.Caller
import ledger.domain.ConflictException
import ledger.domain.Currency
import ledger.domain.EntryKind
import ledger.domain.Errors
import ledger.domain.NotFoundException
import ledger.domain.PostingLine
import ledger.domain.Role
import ledger.domain.SystemRole
import ledger.domain.WireValue
import ledger.domain.validationFailed
import ledger.ledger.Accounts
import ledger.ledger.JournalEntry
import ledger.ledger.LedgerService
import ledger.ledger.NewEntry
import ledger.ledger.requireCustomerFacing
import ledger.outbox.LedgerEvents
import ledger.settlement.BankExpectation
import ledger.settlement.BankExpectations
import ledger.settlement.ExpectationStatus
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.Instant
import java.util.UUID

enum class ResolutionAction(@get:JsonValue override val wire: String) : WireValue {
    DEPOSIT_TO_ACCOUNT("deposit_to_account"),
    TO_SUSPENSE("to_suspense"),
    DISMISS("dismiss")
}

/** Matches statement lines to the ledger and lets operators resolve the lines that do not match. */
@Service
class ReconciliationService(
    private val tx: Tx,
    private val jdbc: JdbcClient,
    private val statements: StatementQueries,
    private val accounts: Accounts,
    private val ledger: LedgerService,
    private val expectations: BankExpectations,
    private val events: LedgerEvents,
    private val clock: Clock
) {
    /** Returns ids of pending lines ordered by statement date and line number. */
    fun pendingLineIds(limit: Int): List<UUID> =
        jdbc.sql(
            """
            SELECT l.id
            FROM statement_lines l
            JOIN statements s ON s.id = l.statement_id
            WHERE l.status = 'pending'
            ORDER BY s.statement_date, l.line_no, s.id
            LIMIT :limit
            """.trimIndent()
        )
            .param("limit", limit)
            .query { rs, _ -> rs.uuid("id") }
            .list()

    /** Reconciles one pending line in its own transaction; returns false when it was no longer pending. */
    fun reconcileLine(lineId: UUID, now: Instant): Boolean =
        tx.inTx {
            val line = statements.lockLine(lineId)
            if (line == null || line.status != LineStatus.PENDING) {
                false
            } else {
                val statement = statements.find(line.statementId)!!
                if (line.amountMinor > 0) reconcileCredit(line, statement, now) else reconcileDebit(line, statement, now)
                true
            }
        }

    /** Counts a failed attempt on a pending line; the fifth failure marks it unmatched with the error as note. */
    fun recordFailure(lineId: UUID, error: Exception, now: Instant) {
        val note = "reconciliation failed: ${error.message ?: error.javaClass.simpleName}".take(MAX_NOTE)
        tx.inTx {
            jdbc.sql(
                """
                UPDATE statement_lines
                SET attempts = attempts + 1,
                    status = CASE WHEN attempts + 1 >= :maxAttempts THEN 'unmatched' ELSE status END,
                    note = CASE WHEN attempts + 1 >= :maxAttempts THEN :note ELSE note END,
                    updated_at = :now
                WHERE id = :id AND status = 'pending'
                """.trimIndent()
            )
                .param("maxAttempts", MAX_ATTEMPTS)
                .param("note", note)
                .param("now", now.toDb())
                .param("id", lineId)
                .update()
        }
    }

    /** Resolves an unmatched or mismatched line by depositing it, moving it to suspense, or dismissing it. */
    fun resolve(caller: Caller, lineId: UUID, action: ResolutionAction, accountId: UUID?, note: String?): StatementLine {
        caller.require(Role.OPERATOR)
        if (action == ResolutionAction.DEPOSIT_TO_ACCOUNT && accountId == null) {
            throw validationFailed("accountId", "is required for deposit_to_account")
        }
        if (action == ResolutionAction.DISMISS && note.isNullOrBlank()) throw validationFailed("note", "is required for dismiss")
        return tx.inTx {
            val line = statements.lockLine(lineId) ?: throw NotFoundException("Statement line $lineId was not found.")
            if (line.status != LineStatus.UNMATCHED && line.status != LineStatus.AMOUNT_MISMATCH) {
                throw ConflictException("invalid_state", "Statement line $lineId is ${line.status.wire}.", mapOf("status" to line.status))
            }
            val statement = statements.find(line.statementId)!!
            val entry = when (action) {
                ResolutionAction.DEPOSIT_TO_ACCOUNT -> depositResolution(caller, line, statement, accountId!!)
                ResolutionAction.TO_SUSPENSE -> suspenseResolution(caller, line, statement)
                ResolutionAction.DISMISS -> null
            }
            jdbc.sql(
                """
                UPDATE statement_lines
                SET status = 'resolved', resolution_entry_id = :entryId, note = COALESCE(:note, note), updated_at = :now
                WHERE id = :id
                """.trimIndent()
            )
                .param("entryId", entry?.id)
                .param("note", note?.trim())
                .param("now", clock.instant().toDb())
                .param("id", lineId)
                .update()
            statements.findLine(lineId)!!
        }
    }

    private fun reconcileCredit(line: StatementLine, statement: Statement, now: Instant) {
        val amount = line.amountMinor
        val currency = statement.currency
        val account = accounts.byDepositReference(line.reference)
        if (account != null && account.currency == currency && account.isCustomerFacing) {
            if (account.status == AccountStatus.CLOSED) {
                val bankCash = systemId(SystemRole.BANK_CASH, currency)
                val entry = post(EntryKind.DEPOSIT, bankCash, systemId(SystemRole.SUSPENSE, currency), amount, currency, null)
                val note = "account ${account.id} is closed; amount posted to suspense"
                updateLine(line, LineStatus.UNMATCHED, now, entryId = entry.id, note = note)
            } else {
                val entry = post(EntryKind.DEPOSIT, systemId(SystemRole.BANK_CASH, currency), account.id, amount, currency, null)
                updateLine(line, LineStatus.MATCHED, now, entryId = entry.id)
            }
            return
        }
        if (line.reference.startsWith(RETURN_PREFIX)) {
            val expectation = expectations.lockByReference(line.reference.removePrefix(RETURN_PREFIX))
            if (expectation != null && returnApplies(expectation, amount, currency)) {
                returnPayout(line, expectation, now)
                return
            }
        }
        updateLine(line, LineStatus.UNMATCHED, now)
    }

    private fun returnApplies(expectation: BankExpectation, amount: Long, currency: Currency): Boolean =
        expectation.currency == currency &&
            expectation.amountMinor == amount &&
            (expectation.status == ExpectationStatus.MATCHED || expectation.status == ExpectationStatus.OPEN)

    private fun returnPayout(line: StatementLine, expectation: BankExpectation, now: Instant) {
        val target = accounts.get(expectation.accountId)
        if (target.status == AccountStatus.CLOSED) {
            updateLine(line, LineStatus.UNMATCHED, now, note = "account ${target.id} is closed")
            return
        }
        val sourceRole = if (expectation.status == ExpectationStatus.MATCHED) SystemRole.BANK_CASH else SystemRole.PAYOUT_CLEARING
        val entry = post(
            EntryKind.PAYOUT_RETURN,
            systemId(sourceRole, expectation.currency),
            target.id,
            line.amountMinor,
            expectation.currency,
            null
        )
        expectations.transition(expectation, expectation.status, ExpectationStatus.RETURNED, now)
        updateLine(line, LineStatus.MATCHED, now, entryId = entry.id, expectationId = expectation.id)
    }

    private fun reconcileDebit(line: StatementLine, statement: Statement, now: Instant) {
        val amount = -line.amountMinor
        val expectation = expectations.lockByReference(line.reference)
        if (expectation == null || expectation.currency != statement.currency || expectation.status != ExpectationStatus.OPEN) {
            updateLine(line, LineStatus.UNMATCHED, now)
            return
        }
        if (expectation.amountMinor != amount) {
            updateLine(line, LineStatus.AMOUNT_MISMATCH, now, expectationId = expectation.id)
            events.discrepancyFound(
                statementId = statement.id,
                lineId = line.id,
                lineNo = line.lineNo,
                reference = line.reference,
                lineAmountMinor = line.amountMinor,
                expectedAmountMinor = expectation.amountMinor,
                currency = statement.currency,
                occurredAt = now
            )
            return
        }
        val currency = statement.currency
        val clearing = systemId(SystemRole.PAYOUT_CLEARING, currency)
        val entry = post(EntryKind.BANK_MATCH, clearing, systemId(SystemRole.BANK_CASH, currency), amount, currency, null)
        check(expectations.transition(expectation, ExpectationStatus.OPEN, ExpectationStatus.MATCHED, now, line.id)) {
            "expectation ${expectation.id} left the open state"
        }
        updateLine(line, LineStatus.MATCHED, now, entryId = entry.id, expectationId = expectation.id)
    }

    private fun depositResolution(caller: Caller, line: StatementLine, statement: Statement, accountId: UUID): JournalEntry {
        if (line.amountMinor <= 0) throw ConflictException("invalid_state", "Only credit lines can be deposited to an account.")
        val account = accounts.get(accountId)
        requireCustomerFacing(account)
        if (account.currency != statement.currency) {
            throw Errors.currencyMismatch("Account $accountId holds ${account.currency}, the statement is in ${statement.currency}.")
        }
        val sourceRole = if (line.entryId != null) SystemRole.SUSPENSE else SystemRole.BANK_CASH
        val source = systemId(sourceRole, statement.currency)
        return post(EntryKind.DEPOSIT, source, account.id, line.amountMinor, statement.currency, caller.keyId)
    }

    private fun suspenseResolution(caller: Caller, line: StatementLine, statement: Statement): JournalEntry? {
        if (line.entryId != null) return null
        val currency = statement.currency
        val bankCash = systemId(SystemRole.BANK_CASH, currency)
        return post(EntryKind.SUSPENSE, bankCash, systemId(SystemRole.SUSPENSE, currency), line.amountMinor, currency, caller.keyId)
    }

    /** Posts [amount] (signed) from [debitAccount] to [creditAccount]. */
    private fun post(
        kind: EntryKind,
        debitAccount: UUID,
        creditAccount: UUID,
        amount: Long,
        currency: Currency,
        actorKeyId: UUID?
    ): JournalEntry =
        ledger.post(
            NewEntry(
                kind = kind,
                lines = listOf(PostingLine(debitAccount, -amount, currency), PostingLine(creditAccount, amount, currency)),
                actorKeyId = actorKeyId
            )
        )

    private fun systemId(role: SystemRole, currency: Currency): UUID = accounts.system(role, currency).id

    private fun updateLine(
        line: StatementLine,
        status: LineStatus,
        now: Instant,
        entryId: UUID? = null,
        expectationId: UUID? = null,
        note: String? = null
    ) {
        jdbc.sql(
            """
            UPDATE statement_lines
            SET status = :status, entry_id = :entryId, matched_expectation_id = :expectationId, note = :note, updated_at = :now
            WHERE id = :id
            """.trimIndent()
        )
            .param("status", status.wire)
            .param("entryId", entryId)
            .param("expectationId", expectationId)
            .param("note", note)
            .param("now", now.toDb())
            .param("id", line.id)
            .update()
    }

    private companion object {
        const val RETURN_PREFIX = "RET-"
        const val MAX_ATTEMPTS = 5
        const val MAX_NOTE = 500
    }
}
