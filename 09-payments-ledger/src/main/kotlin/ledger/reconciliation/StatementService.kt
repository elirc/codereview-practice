package ledger.reconciliation

import ledger.config.IdSource
import ledger.config.Tx
import ledger.config.toDb
import ledger.domain.BusinessRuleException
import ledger.domain.Caller
import ledger.domain.Hashing
import ledger.domain.LineProblem
import ledger.domain.NotFoundException
import ledger.domain.Page
import ledger.domain.PageRequest
import ledger.domain.ParsedStatement
import ledger.domain.Role
import ledger.domain.StatementParser
import ledger.domain.validationFailed
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.jdbc.core.namedparam.SqlParameterSource
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import java.time.Clock
import java.util.UUID

/** The result of an import: the statement and whether this call stored it. */
data class ImportResult(val statement: Statement, val created: Boolean)

/** Imports bank statement files and serves them back. */
@Service
class StatementService(
    private val tx: Tx,
    private val jdbc: JdbcClient,
    private val namedJdbc: NamedParameterJdbcTemplate,
    private val statements: StatementQueries,
    private val ids: IdSource,
    private val clock: Clock
) {
    /**
     * Stores a statement file with all its lines in one transaction. A file whose SHA-256 is already
     * stored returns the existing statement with `created = false`.
     */
    fun importFile(caller: Caller, bankAccountCode: String, bytes: ByteArray): ImportResult {
        caller.require(Role.OPERATOR)
        val sha256 = Hashing.sha256Hex(bytes)
        statements.findBySha(sha256)?.let { return ImportResult(it, created = false) }
        val parsed = StatementParser.parse(bytes, bankAccountCode)

        return tx.inTx {
            jdbc.sql("SELECT 1 FROM (SELECT pg_advisory_xact_lock(:namespace, :key)) AS l")
                .param("namespace", LOCK_NAMESPACE)
                .param("key", bankAccountCode.hashCode())
                .query { _, _ -> 1 }
                .single()
            val existing = statements.findBySha(sha256)
            if (existing != null) return@inTx ImportResult(existing, created = false)
            checkSequence(parsed)
            ImportResult(store(caller, parsed, sha256), created = true)
        }
    }

    fun get(caller: Caller, id: UUID): Statement {
        caller.require(Role.OPERATOR, Role.AUDITOR)
        return statements.find(id) ?: throw NotFoundException("Statement $id was not found.")
    }

    fun lines(caller: Caller, id: UUID, status: LineStatus?, page: PageRequest): Page<StatementLine> {
        get(caller, id)
        val after = page.after?.let { it.toIntOrNull() ?: throw validationFailed("after", "is not a valid cursor") }
        val rows = statements.lines(id, status, after, page.limit + 1)
        return Page.fromFetched(rows, page.limit) { it.lineNo.toString() }
    }

    private fun checkSequence(parsed: ParsedStatement) {
        val header = parsed.header
        val previous = statements.latestFor(header.bankAccountCode) ?: return
        if (previous.currency != header.currency) {
            throw BusinessRuleException(
                "statement_invalid",
                "Bank account ${header.bankAccountCode} reports in ${previous.currency}.",
                mapOf("lines" to listOf(LineProblem(1, "currency ${header.currency} differs from earlier statements")))
            )
        }
        if (!header.statementDate.isAfter(previous.statementDate)) {
            throw BusinessRuleException(
                "statement_gap",
                "The statement date must be after ${previous.statementDate}.",
                mapOf("previousStatementDate" to previous.statementDate)
            )
        }
        if (header.openingMinor != previous.closingMinor) {
            throw BusinessRuleException(
                "statement_gap",
                "The opening balance does not equal the previous closing balance.",
                mapOf("previousClosingMinor" to previous.closingMinor, "openingMinor" to header.openingMinor)
            )
        }
    }

    private fun store(caller: Caller, parsed: ParsedStatement, sha256: String): Statement {
        val header = parsed.header
        val now = clock.instant()
        val statement = Statement(
            id = ids.uuid(),
            bankAccountCode = header.bankAccountCode,
            currency = header.currency,
            statementDate = header.statementDate,
            openingMinor = header.openingMinor,
            closingMinor = header.closingMinor,
            fileSha256 = sha256,
            lineCount = parsed.lines.size,
            importedBy = caller.keyId,
            importedAt = now
        )
        jdbc.sql(
            """
            INSERT INTO statements (id, bank_account_code, currency, statement_date, opening_minor, closing_minor,
                                    file_sha256, line_count, imported_by, imported_at)
            VALUES (:id, :code, :currency, :statementDate, :opening, :closing, :sha, :lineCount, :importedBy, :importedAt)
            """.trimIndent()
        )
            .param("id", statement.id)
            .param("code", statement.bankAccountCode)
            .param("currency", statement.currency.name)
            .param("statementDate", statement.statementDate)
            .param("opening", statement.openingMinor)
            .param("closing", statement.closingMinor)
            .param("sha", sha256)
            .param("lineCount", statement.lineCount)
            .param("importedBy", caller.keyId)
            .param("importedAt", now.toDb())
            .update()

        val known = knownLineIds(header.bankAccountCode, parsed.lines.map { it.bankLineId }.distinct())
        val seen = HashSet<String>(known)
        val rows: List<SqlParameterSource> = parsed.lines.map { line ->
            val status = if (seen.add(line.bankLineId)) LineStatus.PENDING else LineStatus.DUPLICATE
            MapSqlParameterSource()
                .addValue("id", ids.uuid())
                .addValue("statementId", statement.id)
                .addValue("lineNo", line.lineNo)
                .addValue("code", header.bankAccountCode)
                .addValue("bankLineId", line.bankLineId)
                .addValue("bookingDate", line.bookingDate)
                .addValue("amount", line.amountMinor)
                .addValue("reference", line.reference)
                .addValue("description", line.description)
                .addValue("status", status.wire)
                .addValue("now", now.toDb())
        }
        rows.chunked(BATCH_SIZE).forEach { chunk ->
            namedJdbc.batchUpdate(
                """
                INSERT INTO statement_lines (id, statement_id, line_no, bank_account_code, bank_line_id, booking_date,
                                             amount_minor, reference, description, status, created_at, updated_at)
                VALUES (:id, :statementId, :lineNo, :code, :bankLineId, :bookingDate,
                        :amount, :reference, :description, :status, :now, :now)
                """.trimIndent(),
                chunk.toTypedArray()
            )
        }
        return statement
    }

    /** Returns which of [bankLineIds] already exist on non-duplicate lines of the bank account. */
    private fun knownLineIds(bankAccountCode: String, bankLineIds: List<String>): Set<String> =
        bankLineIds.chunked(BATCH_SIZE).flatMap { chunk ->
            jdbc.sql(
                """
                SELECT bank_line_id FROM statement_lines
                WHERE bank_account_code = :code AND bank_line_id IN (:ids) AND status <> 'duplicate'
                """.trimIndent()
            )
                .param("code", bankAccountCode)
                .param("ids", chunk)
                .query(String::class.java)
                .list()
        }.toSet()

    private companion object {
        const val LOCK_NAMESPACE = 9_091
        const val BATCH_SIZE = 1_000
    }
}
