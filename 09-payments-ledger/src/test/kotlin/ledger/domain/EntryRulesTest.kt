package ledger.domain

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.api.assertThrows
import java.util.UUID
import kotlin.test.assertEquals

class EntryRulesTest {
    private val a = UUID.randomUUID()
    private val b = UUID.randomUUID()
    private val c = UUID.randomUUID()
    private val d = UUID.randomUUID()

    @Test
    fun `accepts a balanced two line entry`() {
        assertDoesNotThrow {
            EntryRules.validate(listOf(PostingLine(a, -100, Currency.USD), PostingLine(b, 100, Currency.USD)))
        }
    }

    @Test
    fun `accepts an entry balanced separately in two currencies`() {
        assertDoesNotThrow {
            EntryRules.validate(
                listOf(
                    PostingLine(a, -1000, Currency.USD),
                    PostingLine(b, 1000, Currency.USD),
                    PostingLine(c, -1512, Currency.JPY),
                    PostingLine(d, 1504, Currency.JPY),
                    PostingLine(UUID.randomUUID(), 8, Currency.JPY)
                )
            )
        }
    }

    @Test
    fun `rejects an entry that balances overall but not per currency`() {
        assertThrows<InvalidEntryException> {
            EntryRules.validate(listOf(PostingLine(a, -100, Currency.USD), PostingLine(b, 100, Currency.EUR)))
        }
    }

    @Test
    fun `rejects an unbalanced entry`() {
        assertThrows<InvalidEntryException> {
            EntryRules.validate(listOf(PostingLine(a, -100, Currency.USD), PostingLine(b, 99, Currency.USD)))
        }
    }

    @Test
    fun `rejects fewer than two postings`() {
        assertThrows<InvalidEntryException> { EntryRules.validate(emptyList()) }
        assertThrows<InvalidEntryException> { EntryRules.validate(listOf(PostingLine(a, 0, Currency.USD))) }
    }

    @Test
    fun `rejects zero amounts`() {
        assertThrows<InvalidEntryException> {
            EntryRules.validate(
                listOf(PostingLine(a, -100, Currency.USD), PostingLine(b, 100, Currency.USD), PostingLine(c, 0, Currency.USD))
            )
        }
    }

    @Test
    fun `rejects more than twenty postings`() {
        val lines = (1..21).map { i -> PostingLine(UUID.randomUUID(), if (i == 21) -20L else 1L, Currency.USD) }
        assertThrows<InvalidEntryException> { EntryRules.validate(lines) }
        assertDoesNotThrow { EntryRules.validate(lines.take(19) + PostingLine(a, -19, Currency.USD)) }
    }

    @Test
    fun `sums amounts per currency`() {
        val sums = EntryRules.sumsByCurrency(
            listOf(PostingLine(a, 5, Currency.USD), PostingLine(b, 7, Currency.USD), PostingLine(c, -3, Currency.KWD))
        )
        assertEquals(mapOf(Currency.USD to 12L, Currency.KWD to -3L), sums)
    }
}
