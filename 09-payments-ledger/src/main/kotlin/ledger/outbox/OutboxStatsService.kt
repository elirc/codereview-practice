package ledger.outbox

import ledger.config.instantOrNull
import ledger.domain.Caller
import ledger.domain.Role
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.Duration

data class OutboxStats(val unpublishedCount: Long, val oldestUnpublishedAgeSeconds: Long?, val failingCount: Long)

/** Reports the outbox backlog and how many of its rows have failed to publish. */
@Service
class OutboxStatsService(private val jdbc: JdbcClient, private val clock: Clock) {
    fun stats(caller: Caller): OutboxStats {
        caller.require(Role.OPERATOR)
        return jdbc.sql(
            """
            SELECT count(*) AS pending, min(created_at) AS oldest, count(*) FILTER (WHERE attempts > 0) AS failing
            FROM outbox
            WHERE published_at IS NULL
            """.trimIndent()
        )
            .query { rs, _ ->
                val oldest = rs.instantOrNull("oldest")
                OutboxStats(
                    unpublishedCount = rs.getLong("pending"),
                    oldestUnpublishedAgeSeconds = oldest?.let { Duration.between(it, clock.instant()).seconds.coerceAtLeast(0) },
                    failingCount = rs.getLong("failing")
                )
            }
            .single()
    }
}
