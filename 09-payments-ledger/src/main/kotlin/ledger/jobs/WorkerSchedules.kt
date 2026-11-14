package ledger.jobs

import ledger.outbox.OutboxRelayLoop
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.scheduling.annotation.EnableScheduling
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import java.time.Clock

@Configuration
@Profile("worker")
@EnableScheduling
class SchedulingConfig

/** The periodic loops of the worker process. */
@Component
@Profile("worker")
class WorkerSchedules(
    private val clock: Clock,
    private val jobs: JobRunner,
    private val idempotencyPurge: IdempotencyPurgeJob,
    private val holdExpiry: HoldExpiryJob,
    private val relayLoop: OutboxRelayLoop,
    private val outboxPurge: OutboxPurgeJob
) {
    @Scheduled(fixedDelay = RELAY_MS)
    fun relayOutbox() {
        relayLoop.tick(clock.instant())
    }

    @Scheduled(fixedDelay = HOLD_EXPIRY_MS)
    fun expireHolds() {
        jobs.run("hold-expiry") { holdExpiry.runOnce(clock.instant()) }
    }

    @Scheduled(fixedDelay = HOUR_MS, initialDelay = MINUTE_MS)
    fun purgeIdempotencyKeys() {
        jobs.run("idempotency-purge") { idempotencyPurge.runOnce(clock.instant()) }
    }

    @Scheduled(fixedDelay = HOUR_MS, initialDelay = MINUTE_MS)
    fun purgeOutbox() {
        jobs.run("outbox-purge") { outboxPurge.runOnce(clock.instant()) }
    }

    private companion object {
        const val RELAY_MS = 200L
        const val HOLD_EXPIRY_MS = 30_000L
        const val MINUTE_MS = 60_000L
        const val HOUR_MS = 3_600_000L
    }
}
