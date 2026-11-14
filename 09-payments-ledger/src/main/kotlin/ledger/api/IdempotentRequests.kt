package ledger.api

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.servlet.http.HttpServletRequest
import ledger.domain.Caller
import ledger.domain.Hashing
import ledger.idempotency.ApiResult
import ledger.idempotency.CanonicalJson
import ledger.idempotency.IdempotencyService
import ledger.idempotency.RequestFingerprint
import org.springframework.http.ResponseEntity
import org.springframework.stereotype.Component
import org.springframework.web.servlet.HandlerMapping

/** Runs controller operations under the request's `Idempotency-Key`. */
@Component
class IdempotentRequests(
    private val idempotency: IdempotencyService,
    private val mapper: ObjectMapper
) {
    /** Runs [operation] in one transaction keyed by the request's idempotency key and validated [body]. */
    fun run(caller: Caller, request: HttpServletRequest, body: Any?, operation: () -> ApiResult): ResponseEntity<JsonNode> =
        idempotency.execute(caller, keyOf(request), fingerprint(request, canonicalBody(body)), operation)

    /** Like [run] for operations that commit in several transactions of their own. */
    fun runInSteps(caller: Caller, request: HttpServletRequest, body: Any?, operation: () -> ApiResult): ResponseEntity<JsonNode> =
        idempotency.executeInSteps(caller, keyOf(request), fingerprint(request, canonicalBody(body)), operation)

    /** Like [run] for a raw upload, fingerprinted by the SHA-256 of [bytes] and the query string. */
    fun runUpload(caller: Caller, request: HttpServletRequest, bytes: ByteArray, operation: () -> ApiResult): ResponseEntity<JsonNode> {
        val canonical = "sha256=${Hashing.sha256Hex(bytes)}&query=${request.queryString ?: ""}"
        return idempotency.execute(caller, keyOf(request), fingerprint(request, canonical), operation)
    }

    private fun keyOf(request: HttpServletRequest): String? = request.getHeader(IdempotencyService.HEADER)

    private fun canonicalBody(body: Any?): String = if (body == null) "" else CanonicalJson.write(mapper.valueToTree<JsonNode>(body))

    private fun fingerprint(request: HttpServletRequest, canonicalBody: String): String =
        RequestFingerprint.of(request.method, resolvedPath(request), canonicalBody)

    private fun resolvedPath(request: HttpServletRequest): String {
        val pattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE)?.toString() ?: return request.requestURI
        val variables = request.getAttribute(HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE) as? Map<*, *> ?: emptyMap<String, String>()
        return variables.entries.fold(pattern) { path, (name, value) -> path.replace("{$name}", value.toString()) }
    }
}
