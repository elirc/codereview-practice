package ledger.support

import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/** A UTC clock that tests set and advance explicitly. */
class MutableClock(start: Instant) : Clock() {
    @Volatile
    private var current: Instant = start

    override fun getZone(): ZoneId = ZoneOffset.UTC

    override fun withZone(zone: ZoneId): Clock = this

    override fun instant(): Instant = current

    fun set(instant: Instant) {
        current = instant
    }

    fun advance(duration: Duration) {
        current = current.plus(duration)
    }
}
