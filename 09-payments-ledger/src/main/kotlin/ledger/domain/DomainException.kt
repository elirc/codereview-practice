package ledger.domain

/**
 * A failure the API reports to the caller with a stable error code.
 * [status] is the HTTP status the error maps to.
 */
sealed class DomainException(
    val status: Int,
    val code: String,
    message: String,
    val details: Map<String, Any?> = emptyMap()
) : RuntimeException(message)

class BadRequestException(code: String, message: String, details: Map<String, Any?> = emptyMap()) :
    DomainException(400, code, message, details)

class UnauthenticatedException(message: String = "A valid API key is required.") :
    DomainException(401, "unauthenticated", message)

class ForbiddenException(message: String = "This API key may not perform this action.") :
    DomainException(403, "forbidden", message)

class NotFoundException(message: String = "The requested resource was not found.") :
    DomainException(404, "not_found", message)

class ConflictException(code: String, message: String, details: Map<String, Any?> = emptyMap()) :
    DomainException(409, code, message, details)

class PayloadTooLargeException(message: String) :
    DomainException(413, "payload_too_large", message)

class BusinessRuleException(code: String, message: String, details: Map<String, Any?> = emptyMap()) :
    DomainException(422, code, message, details)

/** A single invalid field reported under `details.fields`. */
data class FieldProblem(val path: String, val message: String)

/** Builds the `validation_failed` error for the given field problems. */
fun validationFailed(fields: List<FieldProblem>): BadRequestException =
    BadRequestException(
        "validation_failed",
        "The request is not valid.",
        mapOf("fields" to fields)
    )

/** Builds the `validation_failed` error for one field. */
fun validationFailed(path: String, message: String): BadRequestException =
    validationFailed(listOf(FieldProblem(path, message)))
