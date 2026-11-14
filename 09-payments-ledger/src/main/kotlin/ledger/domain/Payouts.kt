package ledger.domain

import com.fasterxml.jackson.annotation.JsonValue

enum class SettlementOutcome(@get:JsonValue override val wire: String) : WireValue {
    PAID("paid"),
    SKIPPED_ZERO("skipped_zero"),
    SKIPPED_BELOW_MINIMUM("skipped_below_minimum"),
    SKIPPED_FROZEN("skipped_frozen"),
    SKIPPED_DISABLED("skipped_disabled")
}

/** End-of-day payout arithmetic for one merchant account. */
object Payouts {
    /** Returns the payable amount: the as-of balance, capped by what is available now. */
    fun payable(asOfMinor: Long, availableMinor: Long): Long = minOf(asOfMinor, availableMinor)

    /** Decides the settlement outcome for a merchant account. */
    fun outcome(payoutEnabled: Boolean, status: AccountStatus, payableMinor: Long, minimumMinor: Long): SettlementOutcome =
        when {
            !payoutEnabled -> SettlementOutcome.SKIPPED_DISABLED
            status != AccountStatus.ACTIVE -> SettlementOutcome.SKIPPED_FROZEN
            payableMinor <= 0 -> SettlementOutcome.SKIPPED_ZERO
            payableMinor < minimumMinor -> SettlementOutcome.SKIPPED_BELOW_MINIMUM
            else -> SettlementOutcome.PAID
        }
}
