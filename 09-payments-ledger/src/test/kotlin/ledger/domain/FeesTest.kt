package ledger.domain

import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class FeesTest {
    @ParameterizedTest(name = "{0} at {1} bps is {2}")
    @CsvSource(
        "60, 250, 2",
        "100, 250, 2",
        "20, 250, 0",
        "140, 250, 4",
        "180, 250, 4",
        "1, 1000, 0",
        "5, 1000, 0",
        "15, 1000, 2",
        "100000, 0, 0",
        "123456789, 299, 3691358"
    )
    fun `capture fee rounds half to even`(captureMinor: Long, feeBps: Int, expected: Long) {
        assertEquals(expected, Fees.captureFee(captureMinor, feeBps))
    }

    @Test
    fun `fee never exceeds the capture for allowed rates`() {
        (1L..500L).forEach { amount -> assertTrue(Fees.captureFee(amount, 1000) < amount) }
    }
}
