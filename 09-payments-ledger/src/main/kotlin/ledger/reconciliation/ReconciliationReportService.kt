package ledger.reconciliation

import ledger.config.LedgerProperties
import ledger.config.localDate
import ledger.config.toDb
import ledger.config.uuid
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.domain.Role
import ledger.domain.SystemRole
import ledger.domain.validationFailed
import ledger.domain.wireValueOf
import ledger.ledger.Accounts
import ledger.ledger.BalanceStore
import ledger.settlement.BankExpectations
import ledger.settlement.ExpectationKind
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

data class UnresolvedLine(
    val lineId: UUID,
    val statementId: UUID,
    val bankAccountCode: String,
    val lineNo: Int,
    val bookingDate: LocalDate,
    val amountMinor: Long,
    val currency: Currency,
    val reference: String,
    val status: LineStatus
)

data class OverdueExpectation(
    val expectationId: UUID,
    val kind: ExpectationKind,
    val reference: String,
    val accountId: UUID,
    val amountMinor: Long,
    val currency: Currency,
    val createdAt: Instant
)

/** One bank account: latest statement closing against the ledger's bank cash, with the open items. */
data class BankAccountPosition(
    val bankAccountCode: String,
    val currency: Currency,
    val statementDate: LocalDate,
    val statementClosingMinor: Long,
    val ledgerBankMinor: Long,
    val differenceMinor: Long,
    val unresolvedLineCount: Long,
    val unresolvedLineTotalMinor: Long,
    val openExpectationCount: Long,
    val openExpectationTotalMinor: Long
)

data class ReconciliationReport(
    val from: LocalDate,
    val to: LocalDate,
    val unresolvedLines: List<UnresolvedLine>,
    val overdueExpectations: List<OverdueExpectation>,
    val bankAccounts: List<BankAccountPosition>
)

/** Builds the reconciliation report. */
@Service
class ReconciliationReportService(
    private val jdbc: JdbcClient,
    private val accounts: Accounts,
    private val balances: BalanceStore,
    private val properties: LedgerProperties,
    private val clock: Clock
) {
    /** Returns unresolved lines booked in `[from, to)`, overdue open expectations and the per bank account positions. */
    fun report(caller: Caller, from: LocalDate, to: LocalDate): ReconciliationReport {
        caller.require(Role.OPERATOR, Role.AUDITOR)
        if (!from.isBefore(to)) throw validationFailed("to", "must be after from")
        return ReconciliationReport(from, to, unresolvedLines(from, to), overdueExpectations(), positions())
    }

    private fun unresolvedLines(from: LocalDate, to: LocalDate): List<UnresolvedLine> =
        jdbc.sql(
            """
            SELECT l.id, l.statement_id, l.bank_account_code, l.line_no, l.booking_date, l.amount_minor, s.currency,
                   l.reference, l.status
            FROM statement_lines l
            JOIN statements s ON s.id = l.statement_id
            WHERE l.status IN ('unmatched', 'amount_mismatch') AND l.booking_date >= :from AND l.booking_date < :to
            ORDER BY l.booking_date, s.statement_date, l.line_no
            """.trimIndent()
        )
            .param("from", from)
            .param("to", to)
            .query { rs, _ ->
                UnresolvedLine(
                    lineId = rs.uuid("id"),
                    statementId = rs.uuid("statement_id"),
                    bankAccountCode = rs.getString("bank_account_code"),
                    lineNo = rs.getInt("line_no"),
                    bookingDate = rs.localDate("booking_date"),
                    amountMinor = rs.getLong("amount_minor"),
                    currency = Currency.fromDb(rs.getString("currency")),
                    reference = rs.getString("reference"),
                    status = wireValueOf<LineStatus>(rs.getString("status"))
                )
            }
            .list()

    private fun overdueExpectations(): List<OverdueExpectation> =
        jdbc.sql("SELECT * FROM bank_expectations WHERE status = 'open' AND created_at < :cutoff ORDER BY created_at")
            .param("cutoff", clock.instant().minus(properties.expectationOverdue).toDb())
            .query(BankExpectations.MAPPER)
            .list()
            .map { OverdueExpectation(it.id, it.kind, it.reference, it.accountId, it.amountMinor, it.currency, it.createdAt) }

    private fun positions(): List<BankAccountPosition> {
        val latest = jdbc.sql(
            """
            SELECT DISTINCT ON (bank_account_code) bank_account_code, currency, statement_date, closing_minor
            FROM statements
            ORDER BY bank_account_code, statement_date DESC
            """.trimIndent()
        ).query { rs, _ ->
            LatestStatement(
                rs.getString("bank_account_code"),
                Currency.fromDb(rs.getString("currency")),
                rs.localDate("statement_date"),
                rs.getLong("closing_minor")
            )
        }.list()
        return latest.map { statement ->
            val bankCash = balances.read(accounts.system(SystemRole.BANK_CASH, statement.currency).id)!!
            val ledgerBank = -bankCash.postedMinor
            val lines = jdbc.sql(
                """
                SELECT count(*) AS n, COALESCE(sum(amount_minor), 0) AS total
                FROM statement_lines
                WHERE bank_account_code = :code AND status IN ('pending', 'unmatched', 'amount_mismatch') AND entry_id IS NULL
                """.trimIndent()
            )
                .param("code", statement.code)
                .query { rs, _ -> rs.getLong("n") to rs.getLong("total") }
                .single()
            val open = jdbc.sql(
                """
                SELECT count(*) AS n, COALESCE(sum(amount_minor), 0) AS total
                FROM bank_expectations
                WHERE status = 'open' AND currency = :currency
                """.trimIndent()
            )
                .param("currency", statement.currency.name)
                .query { rs, _ -> rs.getLong("n") to rs.getLong("total") }
                .single()
            BankAccountPosition(
                bankAccountCode = statement.code,
                currency = statement.currency,
                statementDate = statement.date,
                statementClosingMinor = statement.closing,
                ledgerBankMinor = ledgerBank,
                differenceMinor = statement.closing - ledgerBank,
                unresolvedLineCount = lines.first,
                unresolvedLineTotalMinor = lines.second,
                openExpectationCount = open.first,
                openExpectationTotalMinor = open.second
            )
        }
    }

    private data class LatestStatement(val code: String, val currency: Currency, val date: LocalDate, val closing: Long)
}
