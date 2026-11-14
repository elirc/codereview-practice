package ledger.api

import ledger.config.RequestIds
import ledger.domain.DomainException

/** The JSON error body returned by every endpoint. */
data class ErrorResponse(val error: ErrorBody)

data class ErrorBody(
    val code: String,
    val message: String,
    val details: Map<String, Any?>,
    val requestId: String
)

/** Builds error bodies for the current request. */
object ErrorEnvelope {
    fun of(code: String, message: String, details: Map<String, Any?> = emptyMap()): ErrorResponse =
        ErrorResponse(ErrorBody(code, message, details, RequestIds.current()))

    fun of(e: DomainException): ErrorResponse = of(e.code, e.message ?: e.code, e.details)
}
