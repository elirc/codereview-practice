package ledger.api

import com.fasterxml.jackson.databind.JsonNode
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Positive
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.holds.AuthorizeCommand
import ledger.holds.Hold
import ledger.holds.HoldService
import ledger.idempotency.ApiResult
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

data class AuthorizeHoldRequest(
    val accountId: UUID,
    val merchantAccountId: UUID,
    @field:Positive
    val amountMinor: Long,
    val currency: Currency,
    @field:Min(60)
    @field:Max(604_800)
    val expiresInSeconds: Long? = null
)

data class CaptureHoldRequest(
    @field:Positive
    val amountMinor: Long
)

@RestController
@RequestMapping("/v1/holds")
class HoldController(
    private val holds: HoldService,
    private val idempotent: IdempotentRequests
) {
    @PostMapping
    fun authorize(
        caller: Caller,
        @Valid @RequestBody body: AuthorizeHoldRequest,
        request: HttpServletRequest
    ): ResponseEntity<JsonNode> = idempotent.run(caller, request, body) {
        val command = AuthorizeCommand(
            body.accountId,
            body.merchantAccountId,
            body.amountMinor,
            body.currency,
            body.expiresInSeconds ?: DEFAULT_EXPIRY_SECONDS
        )
        ApiResult(HttpStatus.CREATED.value(), holds.authorize(caller, command))
    }

    @GetMapping("/{id}")
    fun get(caller: Caller, @PathVariable id: UUID): Hold = holds.get(caller, id)

    @PostMapping("/{id}/capture")
    fun capture(
        caller: Caller,
        @PathVariable id: UUID,
        @Valid @RequestBody body: CaptureHoldRequest,
        request: HttpServletRequest
    ): ResponseEntity<JsonNode> = idempotent.run(caller, request, body) {
        ApiResult(HttpStatus.OK.value(), holds.capture(caller, id, body.amountMinor))
    }

    @PostMapping("/{id}/release")
    fun release(caller: Caller, @PathVariable id: UUID, request: HttpServletRequest): ResponseEntity<JsonNode> =
        idempotent.run(caller, request, null) {
            ApiResult(HttpStatus.OK.value(), holds.release(caller, id))
        }

    private companion object {
        const val DEFAULT_EXPIRY_SECONDS = 604_800L
    }
}
