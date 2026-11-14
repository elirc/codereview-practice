package ledger.api

import com.fasterxml.jackson.databind.JsonNode
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.idempotency.ApiResult
import ledger.settlement.SettlementService
import ledger.settlement.SettlementView
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.time.LocalDate
import java.util.UUID

data class RunSettlementRequest(
    val businessDate: LocalDate,
    val currency: Currency
)

@RestController
@RequestMapping("/v1/settlements")
class SettlementController(
    private val settlements: SettlementService,
    private val idempotent: IdempotentRequests
) {
    @PostMapping
    fun run(
        caller: Caller,
        @Valid @RequestBody body: RunSettlementRequest,
        request: HttpServletRequest
    ): ResponseEntity<JsonNode> = idempotent.runInSteps(caller, request, body) {
        ApiResult(HttpStatus.OK.value(), settlements.run(caller, body.businessDate, body.currency))
    }

    @GetMapping("/{id}")
    fun get(caller: Caller, @PathVariable id: UUID): SettlementView = settlements.get(caller, id)
}
