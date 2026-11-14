package ledger.api

import com.fasterxml.jackson.databind.JsonNode
import jakarta.servlet.http.HttpServletRequest
import ledger.domain.Caller
import ledger.domain.Page
import ledger.domain.PageRequest
import ledger.domain.PayloadTooLargeException
import ledger.domain.validationFailed
import ledger.idempotency.ApiResult
import ledger.reconciliation.LineStatus
import ledger.reconciliation.Statement
import ledger.reconciliation.StatementLine
import ledger.reconciliation.StatementService
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

@RestController
@RequestMapping("/v1/statements")
class StatementController(
    private val statements: StatementService,
    private val idempotent: IdempotentRequests
) {
    @PostMapping(consumes = ["text/csv"])
    fun importStatement(
        caller: Caller,
        @RequestParam bankAccountCode: String,
        request: HttpServletRequest
    ): ResponseEntity<JsonNode> {
        if (!BANK_ACCOUNT_CODE.matches(bankAccountCode)) {
            throw validationFailed("bankAccountCode", "must be 1 to 64 letters, digits, '-' or '_'")
        }
        val bytes = readBody(request)
        return idempotent.runUpload(caller, request, bytes) {
            val result = statements.importFile(caller, bankAccountCode, bytes)
            val status = if (result.created) HttpStatus.CREATED else HttpStatus.OK
            ApiResult(status.value(), result.statement)
        }
    }

    @GetMapping("/{id}")
    fun get(caller: Caller, @PathVariable id: UUID): Statement = statements.get(caller, id)

    @GetMapping("/{id}/lines")
    fun lines(
        caller: Caller,
        @PathVariable id: UUID,
        @RequestParam(required = false) status: String?,
        @RequestParam(required = false) after: String?,
        @RequestParam(required = false) limit: Int?
    ): Page<StatementLine> {
        val lineStatus = status?.let { value ->
            LineStatus.entries.firstOrNull { it.wire == value } ?: throw validationFailed("status", "is not a line status")
        }
        return statements.lines(caller, id, lineStatus, PageRequest.of(after, limit))
    }

    private fun readBody(request: HttpServletRequest): ByteArray {
        if (request.contentLengthLong > MAX_BYTES) throw tooLarge()
        val bytes = request.inputStream.readNBytes(MAX_BYTES + 1)
        if (bytes.size > MAX_BYTES) throw tooLarge()
        return bytes
    }

    private fun tooLarge() = PayloadTooLargeException("Statement files may be at most 5 MB.")

    private companion object {
        const val MAX_BYTES = 5 * 1024 * 1024
        val BANK_ACCOUNT_CODE = Regex("^[A-Za-z0-9_-]{1,64}$")
    }
}
