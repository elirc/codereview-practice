package ledger.jobs

import ledger.config.toDb
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import java.time.Duration
import java.time.Instant

/** Deletes completed idempotency keys older than the retention period. */
@Component
class IdempotencyPurgeJob(private val jdbc: JdbcClient) {
    /** Deletes expired keys in passes of [BATCH_SIZE] rows and returns how many were deleted. */
    fun runOnce(now: Instant): Int {
        val cutoff = now.minus(RETENTION)
        var total = 0
        do {
            val deleted = jdbc.sql(
                """
                DELETE FROM idempotency_keys
                WHERE (api_key_id, key) IN (
                    SELECT api_key_id, key FROM idempotency_keys
                    WHERE state = 'completed' AND created_at < :cutoff
                    ORDER BY created_at
                    LIMIT :batch
                )
                """.trimIndent()
            )
                .param("cutoff", cutoff.toDb())
                .param("batch", BATCH_SIZE)
                .update()
            total += deleted
        } while (deleted == BATCH_SIZE)
        return total
    }

    companion object {
        const val BATCH_SIZE = 1_000
        val RETENTION: Duration = Duration.ofDays(7)
    }
}
