package ledger.jobs

import ledger.holds.HoldService
import ledger.holds.HoldStore
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.time.Instant

/** Expires active holds whose expiry has passed. */
@Component
class HoldExpiryJob(private val holds: HoldStore, private val holdService: HoldService) {
    private val log = LoggerFactory.getLogger(javaClass)

    /** Expires up to [BATCH_SIZE] due holds, each in its own transaction, and returns how many were expired. */
    fun runOnce(now: Instant): Int {
        var expired = 0
        holds.expiredIds(now, BATCH_SIZE).forEach { id ->
            try {
                if (holdService.expire(id, now)) expired++
            } catch (e: Exception) {
                log.atError().setCause(e).addKeyValue("holdId", id).log("Could not expire hold")
            }
        }
        return expired
    }

    companion object {
        const val BATCH_SIZE = 200
    }
}
