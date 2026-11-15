package ledger.api

import ledger.domain.Caller
import ledger.ledger.AccountService
import ledger.ledger.OwnerBalances
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

@RestController
@RequestMapping("/v1/owners/{ownerId}")
class OwnerController(private val accounts: AccountService) {
    @GetMapping("/balances")
    fun balances(caller: Caller, @PathVariable ownerId: UUID): OwnerBalances = accounts.ownerBalances(caller, ownerId)
}
