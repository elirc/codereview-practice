package ledger.api

import jakarta.validation.Valid
import jakarta.validation.constraints.PositiveOrZero
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.limits.LimitService
import ledger.limits.OwnerLimit
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

data class SetLimitRequest(
    @field:PositiveOrZero
    val dailyOutMinor: Long
)

@RestController
@RequestMapping("/v1/owners/{ownerId}/limits")
class LimitController(private val limits: LimitService) {
    @PutMapping("/{currency}")
    fun setLimit(
        caller: Caller,
        @PathVariable ownerId: UUID,
        @PathVariable currency: Currency,
        @Valid @RequestBody body: SetLimitRequest
    ): OwnerLimit = limits.setLimit(caller, ownerId, currency, body.dailyOutMinor)
}
