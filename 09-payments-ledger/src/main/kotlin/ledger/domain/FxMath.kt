package ledger.domain

import java.math.BigDecimal
import java.math.RoundingMode

/** The three amounts of an FX quote in minor units. */
data class FxAmounts(val sellMinor: Long, val buyMinor: Long, val midBuyMinor: Long) {
    val residueMinor: Long get() = midBuyMinor - buyMinor
}

/** Exchange-rate arithmetic. Rates are buy-currency major units per one sell-currency major unit. */
object FxMath {
    const val RATE_SCALE = 8
    private val BPS = BigDecimal.valueOf(10_000)

    /** Returns `midRate × (10000 − spreadBps) / 10000` at scale 8, rounded down. */
    fun customerRate(midRate: BigDecimal, spreadBps: Int): BigDecimal {
        require(spreadBps in 0 until 10_000) { "spread out of range" }
        return midRate.multiply(BigDecimal.valueOf(10_000L - spreadBps)).divide(BPS, RATE_SCALE, RoundingMode.DOWN)
    }

    /** Amounts for selling exactly [sellMinor]: buy and mid-buy amounts are rounded down. */
    fun forSellAmount(sellMinor: Long, midRate: BigDecimal, customerRate: BigDecimal, sell: Currency, buy: Currency): FxAmounts {
        val factor = minorFactor(sell, buy)
        return FxAmounts(
            sellMinor = sellMinor,
            buyMinor = floorMinor(sellMinor, customerRate, factor),
            midBuyMinor = floorMinor(sellMinor, midRate, factor)
        )
    }

    /** Amounts for buying exactly [buyMinor]: the sell amount is rounded up. */
    fun forBuyAmount(buyMinor: Long, midRate: BigDecimal, customerRate: BigDecimal, sell: Currency, buy: Currency): FxAmounts {
        val factor = minorFactor(sell, buy)
        val buyPerSellMinor = customerRate.multiply(factor)
        require(buyPerSellMinor.signum() > 0) { "customer rate must be positive" }
        val sellMinor = BigDecimal.valueOf(buyMinor).divide(buyPerSellMinor, 0, RoundingMode.CEILING).longValueExact()
        return FxAmounts(
            sellMinor = sellMinor,
            buyMinor = buyMinor,
            midBuyMinor = floorMinor(sellMinor, midRate, factor)
        )
    }

    private fun floorMinor(sellMinor: Long, rate: BigDecimal, factor: BigDecimal): Long =
        BigDecimal.valueOf(sellMinor).multiply(rate).multiply(factor).setScale(0, RoundingMode.FLOOR).longValueExact()

    /** `10^(expBuy − expSell)`, converting a rate between major units into one between minor units. */
    private fun minorFactor(sell: Currency, buy: Currency): BigDecimal = BigDecimal.ONE.scaleByPowerOfTen(buy.exponent - sell.exponent)
}
