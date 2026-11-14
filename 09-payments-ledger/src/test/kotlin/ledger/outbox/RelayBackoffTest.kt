package ledger.outbox

import org.junit.jupiter.api.Test
import java.time.Duration
import kotlin.test.assertEquals

class RelayBackoffTest {
    @Test
    fun `wait doubles with each failed pass from 400 ms`() {
        assertEquals(Duration.ofMillis(200), RelayBackoff.delayAfter(0))
        assertEquals(Duration.ofMillis(400), RelayBackoff.delayAfter(1))
        assertEquals(Duration.ofMillis(800), RelayBackoff.delayAfter(2))
        assertEquals(Duration.ofMillis(1_600), RelayBackoff.delayAfter(3))
        assertEquals(Duration.ofMillis(25_600), RelayBackoff.delayAfter(7))
    }

    @Test
    fun `wait is capped at thirty seconds`() {
        assertEquals(Duration.ofSeconds(30), RelayBackoff.delayAfter(8))
        assertEquals(Duration.ofSeconds(30), RelayBackoff.delayAfter(50))
        assertEquals(Duration.ofSeconds(30), RelayBackoff.delayAfter(Int.MAX_VALUE))
    }
}
