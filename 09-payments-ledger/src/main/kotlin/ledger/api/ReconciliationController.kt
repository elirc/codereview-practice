package ledger.api

import com.fasterxml.jackson.databind.JsonNode
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import jakarta.validation.constraints.Size
import ledger.domain.Caller
import ledger.idempotency.ApiResult
import ledger.ledger.TrialBalance
import ledger.ledger.TrialBalanceService
import ledger.reconciliation.ReconciliationReport
import ledger.reconciliation.ReconciliationReportService
import ledger.reconciliation.ReconciliationService
import ledger.reconciliation.ResolutionAction
import org.springframework.format.annotation.DateTimeFormat
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.time.LocalDate
import java.util.UUID

data class ResolveLineRequest(
    val action: ResolutionAction,
    val accountId: UUID? = null,
    @field:Size(max = 500)
    val note: String? = null
)

@RestController
class ReconciliationController(
    private val reconciliation: ReconciliationService,
    private val reports: ReconciliationReportService,
    private val trialBalances: TrialBalanceService,
    private val idempotent: IdempotentRequests
) {
    @PostMapping("/v1/statement-lines/{id}/resolve")
    fun resolve(
        caller: Caller,
        @PathVariable id: UUID,
        @Valid @RequestBody body: ResolveLineRequest,
        request: HttpServletRequest
    ): ResponseEntity<JsonNode> = idempotent.run(caller, request, body) {
        ApiResult(HttpStatus.OK.value(), reconciliation.resolve(caller, id, body.action, body.accountId, body.note))
    }

    @GetMapping("/v1/reconciliation/report")
    fun report(
        caller: Caller,
        @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) from: LocalDate,
        @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) to: LocalDate
    ): ReconciliationReport = reports.report(caller, from, to)

    @GetMapping("/v1/trial-balance")
    fun trialBalance(caller: Caller): TrialBalance = trialBalances.trialBalance(caller)
}
