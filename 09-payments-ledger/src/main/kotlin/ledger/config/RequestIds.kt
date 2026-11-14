package ledger.config

import org.slf4j.MDC

/** Access to the request id of the current request or job run. */
object RequestIds {
    const val MDC_KEY = "requestId"
    const val HEADER = "X-Request-Id"

    /** Returns the request id bound to the current thread, or `unknown` outside a request or job. */
    fun current(): String = MDC.get(MDC_KEY) ?: "unknown"

    /** Runs [block] with [requestId] bound to the current thread, restoring the previous value afterwards. */
    fun <T> withRequestId(requestId: String, block: () -> T): T {
        val previous = MDC.get(MDC_KEY)
        MDC.put(MDC_KEY, requestId)
        try {
            return block()
        } finally {
            if (previous == null) MDC.remove(MDC_KEY) else MDC.put(MDC_KEY, previous)
        }
    }
}
