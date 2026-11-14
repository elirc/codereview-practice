package ledger.api

import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import ledger.domain.AccountType
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.domain.Page
import ledger.domain.PageRequest
import ledger.ledger.Account
import ledger.ledger.AccountPosting
import ledger.ledger.AccountService
import ledger.ledger.BalanceView
import ledger.ledger.CreateAccountCommand
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

data class CreateAccountRequest(
    val ownerId: UUID,
    val type: AccountType,
    val currency: Currency,
    @field:Min(0)
    @field:Max(1000)
    val feeBps: Int? = null,
    val payoutEnabled: Boolean? = null
)

@RestController
@RequestMapping("/v1/accounts")
class AccountController(private val accounts: AccountService) {
    @PostMapping
    fun create(caller: Caller, @Valid @RequestBody body: CreateAccountRequest): ResponseEntity<Account> {
        val account = accounts.create(
            caller,
            CreateAccountCommand(body.ownerId, body.type, body.currency, body.feeBps, body.payoutEnabled)
        )
        return ResponseEntity.status(HttpStatus.CREATED).body(account)
    }

    @GetMapping("/{id}")
    fun get(caller: Caller, @PathVariable id: UUID): Account = accounts.get(caller, id)

    @GetMapping
    fun list(
        caller: Caller,
        @RequestParam(required = false) ownerId: UUID?,
        @RequestParam(required = false) after: String?,
        @RequestParam(required = false) limit: Int?
    ): Page<Account> = accounts.list(caller, ownerId, PageRequest.of(after, limit))

    @GetMapping("/{id}/balance")
    fun balance(caller: Caller, @PathVariable id: UUID): BalanceView = accounts.balance(caller, id)

    @GetMapping("/{id}/postings")
    fun postings(
        caller: Caller,
        @PathVariable id: UUID,
        @RequestParam(required = false) after: String?,
        @RequestParam(required = false) limit: Int?
    ): Page<AccountPosting> = accounts.postings(caller, id, PageRequest.of(after, limit))
}
