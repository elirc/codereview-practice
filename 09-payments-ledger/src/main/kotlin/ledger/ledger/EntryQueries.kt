package ledger.ledger

import com.fasterxml.jackson.annotation.JsonIgnore
import ledger.config.instant
import ledger.config.uuid
import ledger.config.uuidOrNull
import ledger.domain.Currency
import ledger.domain.EntryKind
import ledger.domain.validationFailed
import ledger.domain.wireValueOf
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import java.time.Instant
import java.util.UUID

/** A posting as seen from one account's statement. */
data class AccountPosting(
    val entryId: UUID,
    val sequence: Long,
    val lineNo: Int,
    val kind: EntryKind,
    val amountMinor: Long,
    val currency: Currency,
    val createdAt: Instant
) {
    @get:JsonIgnore
    val cursor: String get() = "$sequence:$lineNo"
}

/** Position after which a page of account postings starts. */
data class PostingCursor(val sequence: Long, val lineNo: Int) {
    companion object {
        /** Parses a `sequence:lineNo` cursor. */
        fun parse(raw: String): PostingCursor {
            val parts = raw.split(':')
            val sequence = parts.getOrNull(0)?.toLongOrNull()
            val lineNo = parts.getOrNull(1)?.toIntOrNull()
            if (parts.size != 2 || sequence == null || lineNo == null) throw validationFailed("after", "is not a valid cursor")
            return PostingCursor(sequence, lineNo)
        }
    }
}

/** Read queries over journal entries and postings. */
@Component
class EntryQueries(private val jdbc: JdbcClient) {
    fun find(id: UUID): JournalEntry? {
        val header = jdbc.sql("SELECT * FROM journal_entries WHERE id = :id")
            .param("id", id)
            .query(ENTRY)
            .optional()
            .orElse(null) ?: return null
        val postings = jdbc.sql(
            "SELECT line_no, account_id, amount_minor, currency FROM postings WHERE entry_id = :id ORDER BY line_no"
        )
            .param("id", id)
            .query { rs, _ ->
                Posting(
                    lineNo = rs.getInt("line_no"),
                    accountId = rs.uuid("account_id"),
                    amountMinor = rs.getLong("amount_minor"),
                    currency = Currency.fromDb(rs.getString("currency"))
                )
            }
            .list()
        return header.copy(postings = postings)
    }

    /** Returns the id of the entry that reverses [entryId], if one exists. */
    fun reversalOf(entryId: UUID): UUID? =
        jdbc.sql("SELECT id FROM journal_entries WHERE reverses_entry_id = :id")
            .param("id", entryId)
            .query { rs, _ -> rs.uuid("id") }
            .optional()
            .orElse(null)

    /** Lists an account's postings ordered by entry sequence and line number. */
    fun postingsForAccount(accountId: UUID, after: PostingCursor?, limit: Int): List<AccountPosting> {
        val cursorCondition = if (after != null) "AND (e.sequence, p.line_no) > (:afterSequence, :afterLine)" else ""
        val spec = jdbc.sql(
            """
            SELECT p.entry_id, e.sequence, p.line_no, e.kind, p.amount_minor, p.currency, e.created_at
            FROM postings p
            JOIN journal_entries e ON e.id = p.entry_id
            WHERE p.account_id = :accountId $cursorCondition
            ORDER BY e.sequence, p.line_no
            LIMIT :limit
            """.trimIndent()
        )
            .param("accountId", accountId)
            .param("limit", limit)
        if (after != null) {
            spec.param("afterSequence", after.sequence).param("afterLine", after.lineNo)
        }
        return spec.query { rs, _ ->
            AccountPosting(
                entryId = rs.uuid("entry_id"),
                sequence = rs.getLong("sequence"),
                lineNo = rs.getInt("line_no"),
                kind = wireValueOf<EntryKind>(rs.getString("kind")),
                amountMinor = rs.getLong("amount_minor"),
                currency = Currency.fromDb(rs.getString("currency")),
                createdAt = rs.instant("created_at")
            )
        }.list()
    }

    private companion object {
        val ENTRY = RowMapper { rs, _ ->
            JournalEntry(
                id = rs.uuid("id"),
                sequence = rs.getLong("sequence"),
                kind = wireValueOf<EntryKind>(rs.getString("kind")),
                reversesEntryId = rs.uuidOrNull("reverses_entry_id"),
                reason = rs.getString("reason"),
                actorKeyId = rs.uuidOrNull("actor_key_id"),
                requestId = rs.getString("request_id"),
                createdAt = rs.instant("created_at"),
                postings = emptyList()
            )
        }
    }
}
