package ledger.config

import ledger.domain.Currency
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals

class LedgerPropertiesTest {
    private val all = "USD=100,EUR=200,GBP=300,JPY=400,KWD=500"

    @Test
    fun `parses an amount for every currency`() {
        val parsed = LedgerProperties.parseCurrencyAmounts("X", all)
        assertEquals(100L, parsed[Currency.USD])
        assertEquals(500L, parsed[Currency.KWD])
    }

    @Test
    fun `rejects a list missing a currency`() {
        assertThrows<IllegalArgumentException> {
            LedgerProperties.parseCurrencyAmounts("X", "USD=100,EUR=200")
        }
    }

    @Test
    fun `rejects unknown currencies and non integer amounts`() {
        assertThrows<IllegalArgumentException> { LedgerProperties.parseCurrencyAmounts("X", "$all,CHF=1") }
        assertThrows<IllegalArgumentException> {
            LedgerProperties.parseCurrencyAmounts("X", "USD=1.5,EUR=200,GBP=300,JPY=400,KWD=500")
        }
    }

    @Test
    fun `rejects non positive durations`() {
        assertThrows<IllegalArgumentException> {
            LedgerProperties(0, 30, all, all, 72, 3)
        }
    }
}
