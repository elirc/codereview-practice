package ledger.domain

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/** The UTC calendar date of this instant. */
fun Instant.utcDate(): LocalDate = LocalDate.ofInstant(this, ZoneOffset.UTC)

/** The instant at which [date] starts in UTC. */
fun startOfUtcDay(date: LocalDate): Instant = date.atStartOfDay(ZoneOffset.UTC).toInstant()
