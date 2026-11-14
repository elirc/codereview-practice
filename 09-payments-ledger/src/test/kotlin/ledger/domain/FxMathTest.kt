package ledger.domain

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.math.BigDecimal
import kotlin.test.assertEquals

class FxMathTest {
    private val usdJpyMid = BigDecimal("151.23456789")

    @Test
    fun `customer rate applies the spread and rounds down at scale eight`() {
        assertEquals(BigDecimal("150.47839505"), FxMath.customerRate(usdJpyMid, 50))
        assertEquals(BigDecimal("151.23456789"), FxMath.customerRate(usdJpyMid, 0))
        assertEquals(BigDecimal("0.92539998"), FxMath.customerRate(BigDecimal("0.92632631"), 10))
    }

    @Test
    fun `selling ten dollars for yen buys 1504 with a mid amount of 1512`() {
        val amounts = FxMath.forSellAmount(1_000, usdJpyMid, FxMath.customerRate(usdJpyMid, 50), Currency.USD, Currency.JPY)
        assertEquals(FxAmounts(1_000, 1_504, 1_512), amounts)
        assertEquals(8, amounts.residueMinor)
    }

    @Test
    fun `buying a fixed amount rounds the sell amount up`() {
        val rate = FxMath.customerRate(usdJpyMid, 50)
        val amounts = FxMath.forBuyAmount(1_504, usdJpyMid, rate, Currency.USD, Currency.JPY)
        assertEquals(FxAmounts(1_000, 1_504, 1_512), amounts)

        val noSpread = FxMath.forBuyAmount(1_504, usdJpyMid, usdJpyMid, Currency.USD, Currency.JPY)
        assertEquals(FxAmounts(995, 1_504, 1_504), noSpread)
        assertEquals(0, noSpread.residueMinor)
    }

    @Test
    fun `exponent differences work in both directions`() {
        val jpyUsd = BigDecimal("0.00661227")
        val amounts = FxMath.forSellAmount(10_000, jpyUsd, jpyUsd, Currency.JPY, Currency.USD)
        assertEquals(FxAmounts(10_000, 6_612, 6_612), amounts)

        val usdKwd = BigDecimal("0.30710000")
        assertEquals(FxAmounts(250, 767, 767), FxMath.forSellAmount(250, usdKwd, usdKwd, Currency.USD, Currency.KWD))
    }

    @Test
    fun `tiny sales can round to nothing`() {
        val jpyUsd = BigDecimal("0.00661227")
        assertEquals(0, FxMath.forSellAmount(1, jpyUsd, jpyUsd, Currency.JPY, Currency.USD).buyMinor)
    }

    @Test
    fun `spread must be below ten thousand basis points`() {
        assertThrows<IllegalArgumentException> { FxMath.customerRate(usdJpyMid, 10_000) }
    }
}
