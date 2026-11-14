package ledger.domain

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals

class MoneyTest {
    @Test
    fun `parses amounts with exactly the currency exponent`() {
        assertEquals(-1250L, MinorUnits.parse("-12.50", Currency.USD))
        assertEquals(1200L, MinorUnits.parse("1200", Currency.JPY))
        assertEquals(125L, MinorUnits.parse("0.125", Currency.KWD))
        assertEquals(5L, MinorUnits.parse("0.05", Currency.EUR))
        assertEquals(0L, MinorUnits.parse("0.00", Currency.GBP))
    }

    @Test
    fun `rejects amounts with the wrong number of decimals`() {
        listOf("12.5", "12", "12.500", "1.2.3").forEach { text ->
            assertThrows<IllegalArgumentException>(text) { MinorUnits.parse(text, Currency.USD) }
        }
        listOf("1200.00", "1200.0", "12.").forEach { text ->
            assertThrows<IllegalArgumentException>(text) { MinorUnits.parse(text, Currency.JPY) }
        }
        listOf("0.12", "0.1250").forEach { text ->
            assertThrows<IllegalArgumentException>(text) { MinorUnits.parse(text, Currency.KWD) }
        }
    }

    @Test
    fun `rejects signs, spaces, exponents and leading zeros`() {
        listOf("+1.00", " 1.00", "1.00 ", "1e2", "01.00", "-", "", "1,00").forEach { text ->
            assertThrows<IllegalArgumentException>(text) { MinorUnits.parse(text, Currency.USD) }
        }
    }

    @Test
    fun `rejects amounts outside the long range`() {
        assertThrows<IllegalArgumentException> { MinorUnits.parse("99999999999999999999.00", Currency.USD) }
    }

    @Test
    fun `formats minor units with the currency exponent`() {
        assertEquals("-12.50", MinorUnits.format(-1250, Currency.USD))
        assertEquals("0.05", MinorUnits.format(5, Currency.USD))
        assertEquals("1200", MinorUnits.format(1200, Currency.JPY))
        assertEquals("0.125", MinorUnits.format(125, Currency.KWD))
        assertEquals("-0.001", MinorUnits.format(-1, Currency.KWD))
    }

    @Test
    fun `money adds within one currency only`() {
        assertEquals(Money(300, Currency.USD), Money(100, Currency.USD) + Money(200, Currency.USD))
        assertThrows<IllegalArgumentException> { Money(1, Currency.USD) + Money(1, Currency.EUR) }
        assertEquals("1.25", Money.parse("1.25", Currency.GBP).format())
        assertEquals(Money(-7, Currency.JPY), -Money(7, Currency.JPY))
    }
}
