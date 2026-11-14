package ledger.api

import com.fasterxml.jackson.databind.JsonNode
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import jakarta.validation.constraints.Positive
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.idempotency.ApiResult
import ledger.transfers.TransferCommand
import ledger.transfers.TransferService
import ledger.transfers.WithdrawalCommand
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

data class TransferRequest(
    val fromAccountId: UUID,
    val toAccountId: UUID,
    @field:Positive
    val amountMinor: Long,
    val currency: Currency
)

data class WithdrawalRequest(
    val accountId: UUID,
    @field:Positive
    val amountMinor: Long,
    val currency: Currency
)

@RestController
@RequestMapping("/v1")
class TransferController(
    private val transfers: TransferService,
    private val idempotent: IdempotentRequests
) {
    @PostMapping("/transfers")
    fun transfer(
        caller: Caller,
        @Valid @RequestBody body: TransferRequest,
        request: HttpServletRequest
    ): ResponseEntity<JsonNode> = idempotent.run(caller, request, body) {
        val command = TransferCommand(body.fromAccountId, body.toAccountId, body.amountMinor, body.currency)
        ApiResult(HttpStatus.CREATED.value(), transfers.transfer(caller, command))
    }

    @PostMapping("/withdrawals")
    fun withdraw(
        caller: Caller,
        @Valid @RequestBody body: WithdrawalRequest,
        request: HttpServletRequest
    ): ResponseEntity<JsonNode> = idempotent.run(caller, request, body) {
        ApiResult(HttpStatus.CREATED.value(), transfers.withdraw(caller, WithdrawalCommand(body.accountId, body.amountMinor, body.currency)))
    }
}
