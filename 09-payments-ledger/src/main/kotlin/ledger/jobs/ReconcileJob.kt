package ledger.jobs

import ledger.reconciliation.ReconciliationService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.time.Instant

/** Reconciles pending statement lines. */
@Component
class ReconcileJob(private val reconciliation: ReconciliationService) {
    private val log = LoggerFactory.getLogger(javaClass)

    /** Processes up to [BATCH_SIZE] pending lines, each in its own transaction, and returns how many it processed. */
    fun runOnce(now: Instant): Int {
        var processed = 0
        reconciliation.pendingLineIds(BATCH_SIZE).forEach { lineId ->
            try {
                if (reconciliation.reconcileLine(lineId, now)) processed++
            } catch (e: Exception) {
                log.atError().setCause(e).addKeyValue("lineId", lineId).log("Reconciling a statement line failed")
                try {
                    reconciliation.recordFailure(lineId, e, now)
                } catch (inner: Exception) {
                    log.atError().setCause(inner).addKeyValue("lineId", lineId).log("Recording a reconciliation failure failed")
                }
            }
        }
        return processed
    }

    companion object {
        const val BATCH_SIZE = 500
    }
}
