package ledger.api

import com.fasterxml.jackson.databind.JsonMappingException
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException
import ledger.domain.DomainException
import ledger.domain.FieldProblem
import ledger.domain.validationFailed
import org.slf4j.LoggerFactory
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.web.HttpMediaTypeNotSupportedException
import org.springframework.web.HttpRequestMethodNotSupportedException
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.MissingRequestHeaderException
import org.springframework.web.bind.MissingServletRequestParameterException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException
import org.springframework.web.servlet.NoHandlerFoundException
import org.springframework.web.servlet.resource.NoResourceFoundException

/** Maps every exception that leaves a controller to the error envelope. */
@RestControllerAdvice
class ApiExceptionHandler {
    private val log = LoggerFactory.getLogger(javaClass)

    @ExceptionHandler(DomainException::class)
    fun domain(e: DomainException): ResponseEntity<ErrorResponse> = respond(e.status, ErrorEnvelope.of(e))

    @ExceptionHandler(MethodArgumentNotValidException::class)
    fun invalidBody(e: MethodArgumentNotValidException): ResponseEntity<ErrorResponse> {
        val fields = e.bindingResult.fieldErrors.map { FieldProblem(it.field, it.defaultMessage ?: "is invalid") } +
            e.bindingResult.globalErrors.map { FieldProblem("", it.defaultMessage ?: "is invalid") }
        return domain(validationFailed(fields))
    }

    @ExceptionHandler(HttpMessageNotReadableException::class)
    fun unreadable(e: HttpMessageNotReadableException): ResponseEntity<ErrorResponse> {
        val problem = when (val cause = e.cause) {
            is UnrecognizedPropertyException -> FieldProblem(pathOf(cause), "is not a recognised field")
            is JsonMappingException -> FieldProblem(pathOf(cause), "is missing or has an invalid value")
            else -> FieldProblem("", "the request body is not valid JSON")
        }
        return domain(validationFailed(listOf(problem)))
    }

    @ExceptionHandler(MissingRequestHeaderException::class)
    fun missingHeader(e: MissingRequestHeaderException): ResponseEntity<ErrorResponse> =
        domain(validationFailed(e.headerName, "header is required"))

    @ExceptionHandler(MissingServletRequestParameterException::class)
    fun missingParameter(e: MissingServletRequestParameterException): ResponseEntity<ErrorResponse> =
        domain(validationFailed(e.parameterName, "parameter is required"))

    @ExceptionHandler(MethodArgumentTypeMismatchException::class)
    fun typeMismatch(e: MethodArgumentTypeMismatchException): ResponseEntity<ErrorResponse> =
        domain(validationFailed(e.name, "has an invalid value"))

    @ExceptionHandler(HttpMediaTypeNotSupportedException::class)
    fun unsupportedMediaType(e: HttpMediaTypeNotSupportedException): ResponseEntity<ErrorResponse> =
        respond(415, ErrorEnvelope.of("unsupported_media_type", "Content type ${e.contentType ?: "(none)"} is not supported."))

    @ExceptionHandler(HttpRequestMethodNotSupportedException::class)
    fun methodNotAllowed(e: HttpRequestMethodNotSupportedException): ResponseEntity<ErrorResponse> =
        respond(405, ErrorEnvelope.of("method_not_allowed", "Method ${e.method} is not allowed here."))

    @ExceptionHandler(NoHandlerFoundException::class, NoResourceFoundException::class)
    fun noRoute(e: Exception): ResponseEntity<ErrorResponse> =
        respond(404, ErrorEnvelope.of("not_found", "The requested resource was not found."))

    @ExceptionHandler(Exception::class)
    fun unexpected(e: Exception): ResponseEntity<ErrorResponse> {
        log.error("Unhandled error while processing request", e)
        return respond(500, ErrorEnvelope.of("internal_error", "An unexpected error occurred."))
    }

    private fun respond(status: Int, body: ErrorResponse): ResponseEntity<ErrorResponse> =
        ResponseEntity.status(status).body(body)

    private fun pathOf(e: JsonMappingException): String =
        e.path.joinToString(".") { ref -> ref.fieldName ?: "[${ref.index}]" }
}
