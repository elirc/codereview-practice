package ledger.domain

import java.util.UUID

/** One line of a journal entry before it is posted. Positive amounts increase the account's balance. */
data class PostingLine(val accountId: UUID, val amountMinor: Long, val currency: Currency)

class InvalidEntryException(message: String) : IllegalArgumentException(message)

/** Structural rules every journal entry satisfies. */
object EntryRules {
    const val MIN_POSTINGS = 2
    const val MAX_POSTINGS = 20

    /** Throws [InvalidEntryException] unless [lines] form a balanced entry. */
    fun validate(lines: List<PostingLine>) {
        if (lines.size < MIN_POSTINGS) {
            throw InvalidEntryException("an entry needs at least $MIN_POSTINGS postings, got ${lines.size}")
        }
        if (lines.size > MAX_POSTINGS) {
            throw InvalidEntryException("an entry may have at most $MAX_POSTINGS postings, got ${lines.size}")
        }
        lines.forEachIndexed { index, line ->
            if (line.amountMinor == 0L) throw InvalidEntryException("posting ${index + 1} has a zero amount")
        }
        sumsByCurrency(lines).forEach { (currency, sum) ->
            if (sum != 0L) throw InvalidEntryException("postings in $currency sum to $sum instead of zero")
        }
    }

    /** Returns the sum of the amounts per currency. */
    fun sumsByCurrency(lines: List<PostingLine>): Map<Currency, Long> =
        lines.groupBy { it.currency }.mapValues { (_, group) -> group.fold(0L) { acc, line -> Math.addExact(acc, line.amountMinor) } }
}
