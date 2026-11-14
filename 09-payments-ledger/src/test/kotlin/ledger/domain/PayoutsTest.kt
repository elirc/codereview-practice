package ledger.domain

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class PayoutsTest {
    @Test
    fun `payable is the as of balance capped by what is available now`() {
        assertEquals(5_000, Payouts.payable(5_000, 8_000))
        assertEquals(2_000, Payouts.payable(5_000, 2_000))
        assertEquals(0, Payouts.payable(0, 3_000))
        assertEquals(-100, Payouts.payable(-100, 50))
    }

    @Test
    fun `outcome checks payout setting, status, zero and minimum in that order`() {
        assertEquals(SettlementOutcome.SKIPPED_DISABLED, Payouts.outcome(false, AccountStatus.FROZEN, 0, 1_000))
        assertEquals(SettlementOutcome.SKIPPED_FROZEN, Payouts.outcome(true, AccountStatus.FROZEN, 5_000, 1_000))
        assertEquals(SettlementOutcome.SKIPPED_FROZEN, Payouts.outcome(true, AccountStatus.CLOSED, 0, 1_000))
        assertEquals(SettlementOutcome.SKIPPED_ZERO, Payouts.outcome(true, AccountStatus.ACTIVE, 0, 1_000))
        assertEquals(SettlementOutcome.SKIPPED_ZERO, Payouts.outcome(true, AccountStatus.ACTIVE, -5, 1_000))
        assertEquals(SettlementOutcome.SKIPPED_BELOW_MINIMUM, Payouts.outcome(true, AccountStatus.ACTIVE, 999, 1_000))
        assertEquals(SettlementOutcome.PAID, Payouts.outcome(true, AccountStatus.ACTIVE, 1_000, 1_000))
    }
}
