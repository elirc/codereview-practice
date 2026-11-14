package ledger.reconciliation

import com.fasterxml.jackson.annotation.JsonValue
import ledger.config.instant
import ledger.config.localDate
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

enum class LineStatus(@get:JsonValue override val wire: String) : WireValue {
    PENDING("pending"),
    MATCHED("matched"),
    UNMATCHED("unmatched"),
    AMOUNT_MISMATCH("amount_mismatch"),
    DUPLICATE("duplicate"),
    RESOLVED("resolved")
}

data class Statement(
    val id: UUID,
    val bankAccountCode: String,
    val currency: Currency,
    val statementDate: LocalDate,
    val openingMinor: Long,
    val closingMinor: Long,
    val fileSha256: String,
    val lineCount: Int,
    val importedBy: UUID,
    val importedAt: Instant
)

data class StatementLine(
    val id: UUID,
    val statementId: UUID,
    val lineNo: Int,
    val bankAccountCode: String,
    val bankLineId: String,
    val bookingDate: LocalDate,
    val amountMinor: Long,
    val reference: String,
    val description: String,
    val status: LineStatus,
    val matchedExpectationId: UUID?,
    val entryId: UUID?,
    val resolutionEntryId: UUID?,
    val note: String?,
    val attempts: Int,
    val createdAt: Instant,
    val updatedAt: Instant
)

/** Read queries over statements and their lines. */
@Component
class StatementQueries(private val jdbc: JdbcClient) {
    fun find(id: UUID): Statement? =
        jdbc.sql("SELECT * FROM statements WHERE id = :id")
            .param("id", id)
            .query(STATEMENT)
            .optional()
            .orElse(null)

    fun findBySha(sha256: String): Statement? =
        jdbc.sql("SELECT * FROM statements WHERE file_sha256 = :sha")
            .param("sha", sha256)
            .query(STATEMENT)
            .optional()
            .orElse(null)

    /** Returns the statement with the latest statement date for the bank account. */
    fun latestFor(bankAccountCode: String): Statement? =
        jdbc.sql("SELECT * FROM statements WHERE bank_account_code = :code ORDER BY statement_date DESC LIMIT 1")
            .param("code", bankAccountCode)
            .query(STATEMENT)
            .optional()
            .orElse(null)

    fun findLine(id: UUID): StatementLine? =
        jdbc.sql("SELECT * FROM statement_lines WHERE id = :id")
            .param("id", id)
            .query(LINE)
            .optional()
            .orElse(null)

    /** Locks and returns a statement line. */
    fun lockLine(id: UUID): StatementLine? =
        jdbc.sql("SELECT * FROM statement_lines WHERE id = :id FOR UPDATE")
            .param("id", id)
            .query(LINE)
            .optional()
            .orElse(null)

    /** Lists a statement's lines by line number, optionally with one status. */
    fun lines(statementId: UUID, status: LineStatus?, afterLineNo: Int?, limit: Int): List<StatementLine> {
        val conditions = mutableListOf("statement_id = :statementId")
        val params = mutableMapOf<String, Any>("statementId" to statementId, "limit" to limit)
        if (status != null) {
            conditions += "status = :status"
            params["status"] = status.wire
        }
        if (afterLineNo != null) {
            conditions += "line_no > :after"
            params["after"] = afterLineNo
        }
        return jdbc.sql("SELECT * FROM statement_lines WHERE ${conditions.joinToString(" AND ")} ORDER BY line_no LIMIT :limit")
            .params(params)
            .query(LINE)
            .list()
    }

    companion object {
        val STATEMENT = RowMapper { rs, _ ->
            Statement(
                id = rs.uuid("id"),
                bankAccountCode = rs.getString("bank_account_code"),
                currency = Currency.fromDb(rs.getString("currency")),
                statementDate = rs.localDate("statement_date"),
                openingMinor = rs.getLong("opening_minor"),
                closingMinor = rs.getLong("closing_minor"),
                fileSha256 = rs.getString("file_sha256"),
                lineCount = rs.getInt("line_count"),
                importedBy = rs.uuid("imported_by"),
                importedAt = rs.instant("imported_at")
            )
        }

        val LINE = RowMapper { rs, _ ->
            StatementLine(
                id = rs.uuid("id"),
                statementId = rs.uuid("statement_id"),
                lineNo = rs.getInt("line_no"),
                bankAccountCode = rs.getString("bank_account_code"),
                bankLineId = rs.getString("bank_line_id"),
                bookingDate = rs.localDate("booking_date"),
                amountMinor = rs.getLong("amount_minor"),
                reference = rs.getString("reference"),
                description = rs.getString("description"),
                status = wireValueOf<LineStatus>(rs.getString("status")),
                matchedExpectationId = rs.uuidOrNull("matched_expectation_id"),
                entryId = rs.uuidOrNull("entry_id"),
                resolutionEntryId = rs.uuidOrNull("resolution_entry_id"),
                note = rs.getString("note"),
                attempts = rs.getInt("attempts"),
                createdAt = rs.instant("created_at"),
                updatedAt = rs.instant("updated_at")
            )
        }
    }
}
