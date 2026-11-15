package ledger.jobs

import ledger.config.LedgerProperties
import ledger.config.toDb
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import java.time.Instant

/** Deletes outbox rows older than the retention period. */
@Component
class OutboxPurgeJob(private val jdbc: JdbcClient, private val properties: LedgerProperties) {
    /** Deletes old rows in batches and returns how many were deleted. */
    fun runOnce(now: Instant): Int {
        val cutoff = now.minus(properties.outboxRetention)
        var total = 0
        do {
            val deleted = jdbc.sql(
                """
                DELETE FROM outbox
                WHERE id IN (
                    SELECT id FROM outbox
                    WHERE created_at < :cutoff
                    ORDER BY id
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

    private companion object {
        const val BATCH_SIZE = 5_000
    }
}
