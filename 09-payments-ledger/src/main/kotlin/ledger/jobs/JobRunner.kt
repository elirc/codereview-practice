package ledger.jobs

import ledger.config.IdSource
import ledger.config.RequestIds
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component

/** Runs one pass of a periodic job with its own request id and start, finish and failure logs. */
@Component
class JobRunner(private val ids: IdSource) {
    private val log = LoggerFactory.getLogger(javaClass)

    /** Runs [block] and returns its result, or null when it threw; failures are logged, not rethrown. */
    fun <T> run(job: String, block: () -> T): T? {
        val jobId = "job-${ids.uuid()}"
        return RequestIds.withRequestId(jobId) {
            log.atInfo().addKeyValue("job", job).addKeyValue("jobId", jobId).addKeyValue("attempt", 1).log("Job started")
            try {
                val result = block()
                log.atInfo().addKeyValue("job", job).addKeyValue("jobId", jobId).addKeyValue("attempt", 1)
                    .addKeyValue("result", result.toString()).log("Job finished")
                result
            } catch (e: Exception) {
                log.atError().setCause(e).addKeyValue("job", job).addKeyValue("jobId", jobId).addKeyValue("attempt", 1)
                    .log("Job failed")
                null
            }
        }
    }
}
