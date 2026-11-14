package ledger.jobs

import ledger.domain.Currency
import ledger.domain.utcDate
import ledger.settlement.SettlementService
import ledger.settlement.SettlementView
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.time.Instant

/** Runs settlement for the previous UTC day in every currency and resumes earlier unfinished batches. */
@Component
class SettlementTriggerJob(private val settlements: SettlementService) {
    private val log = LoggerFactory.getLogger(javaClass)

    /** Returns the batches it ran, earlier unfinished ones first. */
    fun runOnce(now: Instant): List<SettlementView> {
        val yesterday = now.utcDate().minusDays(1)
        val targets = settlements.unfinishedBefore(yesterday) + Currency.entries.map { yesterday to it }
        return targets.mapNotNull { (date, currency) ->
            try {
                settlements.run(date, currency, now, null)
            } catch (e: Exception) {
                log.atError().setCause(e).addKeyValue("businessDate", date).addKeyValue("currency", currency)
                    .log("Settlement run failed")
                null
            }
        }
    }
}
