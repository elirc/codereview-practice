package ledger.domain

import java.math.BigDecimal
import java.math.RoundingMode

object Fees {
    private val BPS_DIVISOR = BigDecimal(10_000)

    /** Returns `roundHalfEven(captureMinor × feeBps / 10000)` in minor units. */
    fun captureFee(captureMinor: Long, feeBps: Int): Long {
        require(captureMinor >= 0) { "capture amount must not be negative" }
        require(feeBps in 0..10_000) { "fee basis points out of range" }
        return BigDecimal.valueOf(captureMinor)
            .multiply(BigDecimal.valueOf(feeBps.toLong()))
            .divide(BPS_DIVISOR, 0, RoundingMode.HALF_EVEN)
            .longValueExact()
    }
}
