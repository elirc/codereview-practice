package ledger.outbox

import ledger.config.Tx
import ledger.config.toDb
import ledger.config.uuid
import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.simple.JdbcClient
import java.time.Duration
import java.time.Instant

/** Outcome of one relay pass. */
data class RelayResult(val published: Int, val failed: Boolean, val skipped: Boolean) {
    companion object {
        val SKIPPED = RelayResult(0, failed = false, skipped = true)
    }
}

/** Publishes unpublished outbox rows in id order and records the error on rows that fail. */
class OutboxRelay(
    private val tx: Tx,
    private val jdbc: JdbcClient,
    private val publisher: EventPublisher,
    private val batchSize: Int = DEFAULT_BATCH_SIZE
) {
    private val log = LoggerFactory.getLogger(javaClass)

    /**
     * Sends up to [batchSize] unpublished rows in id order, marks the sent rows published at [now], counts an attempt
     * with its error on each row that failed and returns the outcome.
     */
    fun runOnce(now: Instant): RelayResult = tx.inTx {
        val locked = jdbc.sql("SELECT pg_try_advisory_xact_lock(:key)")
            .param("key", LOCK_KEY)
            .query(Boolean::class.javaObjectType)
            .single()
        if (!locked) return@inTx RelayResult.SKIPPED

        val rows = jdbc.sql(
            """
            SELECT id, event_id, topic, partition_key, payload ->> 'type' AS event_type, payload::text AS payload
            FROM outbox
            WHERE published_at IS NULL
            ORDER BY id
            LIMIT :limit
            """.trimIndent()
        )
            .param("limit", batchSize)
            .query { rs, _ ->
                OutboxRecord(
                    id = rs.getLong("id"),
                    eventId = rs.uuid("event_id"),
                    topic = rs.getString("topic"),
                    key = rs.getString("partition_key"),
                    eventType = rs.getString("event_type"),
                    payload = rs.getString("payload")
                )
            }
            .list()

        val published = mutableListOf<Long>()
        val failures = mutableListOf<Pair<OutboxRecord, Exception>>()
        for (row in rows) {
            try {
                publisher.publish(row)
                published += row.id
            } catch (e: Exception) {
                failures += row to e
            }
        }

        if (published.isNotEmpty()) {
            jdbc.sql("UPDATE outbox SET published_at = :now WHERE id IN (:ids)")
                .param("now", now.toDb())
                .param("ids", published)
                .update()
        }
        failures.forEach { (row, failure) -> recordFailure(row, failure) }
        RelayResult(published.size, failed = failures.isNotEmpty(), skipped = false)
    }

    private fun recordFailure(row: OutboxRecord, failure: Exception) {
        val message = (failure.message ?: failure.javaClass.name).take(MAX_ERROR_LENGTH)
        jdbc.sql("UPDATE outbox SET attempts = attempts + 1, last_error = :error WHERE id = :id")
            .param("error", message)
            .param("id", row.id)
            .update()
        log.atWarn().addKeyValue("outboxId", row.id).addKeyValue("eventId", row.eventId)
            .log("Publishing an outbox event failed: {}", message)
    }

    companion object {
        const val DEFAULT_BATCH_SIZE = 200
        const val LOCK_KEY = 9_091_001L
        private const val MAX_ERROR_LENGTH = 1_000
    }
}

/** The wait before the next relay pass after a number of failed passes in a row. */
object RelayBackoff {
    val BASE: Duration = Duration.ofMillis(200)
    val MAX: Duration = Duration.ofSeconds(30)

    /** Returns `min(30 s, 2^consecutiveFailures × 200 ms)`. */
    fun delayAfter(consecutiveFailures: Int): Duration {
        if (consecutiveFailures <= 0) return BASE
        val exponent = minOf(consecutiveFailures, 20)
        val millis = BASE.toMillis() * (1L shl exponent)
        return if (millis >= MAX.toMillis()) MAX else Duration.ofMillis(millis)
    }
}

/** Runs relay passes on the worker schedule, waiting longer after failed passes. */
class OutboxRelayLoop(private val relay: OutboxRelay) {
    private val log = LoggerFactory.getLogger(javaClass)
    private var consecutiveFailures = 0
    private var nextPassAt: Instant = Instant.MIN

    /** Runs a pass unless the back-off since the last failure has not elapsed; returns its result or null. */
    @Synchronized
    fun tick(now: Instant): RelayResult? {
        if (now.isBefore(nextPassAt)) return null
        val result = try {
            relay.runOnce(now)
        } catch (e: Exception) {
            log.atError().setCause(e).log("Outbox relay pass failed")
            RelayResult(0, failed = true, skipped = false)
        }
        if (result.failed) {
            consecutiveFailures++
            nextPassAt = now.plus(RelayBackoff.delayAfter(consecutiveFailures))
        } else {
            consecutiveFailures = 0
            nextPassAt = now
        }
        if (result.published > 0) {
            log.atInfo().addKeyValue("published", result.published).log("Outbox events published")
        }
        return result
    }
}
