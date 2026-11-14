package ledger.api

import com.fasterxml.jackson.databind.JsonNode
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Positive
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.fx.FxQuote
import ledger.fx.FxRate
import ledger.fx.FxService
import ledger.fx.FxTransferCommand
import ledger.fx.QuoteCommand
import ledger.idempotency.ApiResult
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.math.BigDecimal
import java.time.Instant
import java.util.UUID

data class PublishRateRequest(
    val sellCurrency: Currency,
    val buyCurrency: Currency,
    @field:Pattern(regexp = "^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,8})?$", message = "must be a decimal with at most 8 decimals")
    val midRate: String,
    @field:Min(0)
    @field:Max(9_999)
    val spreadBps: Int
)

data class QuoteRequest(
    val ownerId: UUID,
    val sellCurrency: Currency,
    val buyCurrency: Currency,
    @field:Positive
    val sellAmountMinor: Long? = null,
    @field:Positive
    val buyAmountMinor: Long? = null
)

data class FxTransferRequest(
    val quoteId: UUID,
    val fromAccountId: UUID,
    val toAccountId: UUID
)

data class RateResponse(
    val id: UUID,
    val sellCurrency: Currency,
    val buyCurrency: Currency,
    val midRate: String,
    val spreadBps: Int,
    val publishedAt: Instant,
    val publishedBy: UUID
) {
    companion object {
        fun of(rate: FxRate) = RateResponse(
            rate.id,
            rate.sellCurrency,
            rate.buyCurrency,
            rate.midRate.toPlainString(),
            rate.spreadBps,
            rate.publishedAt,
            rate.publishedBy
        )
    }
}

data class QuoteResponse(
    val id: UUID,
    val ownerId: UUID,
    val rateId: UUID,
    val sellCurrency: Currency,
    val buyCurrency: Currency,
    val sellMinor: Long,
    val buyMinor: Long,
    val midBuyMinor: Long,
    val midRate: String,
    val customerRate: String,
    val expiresAt: Instant,
    val usedEntryId: UUID?
) {
    companion object {
        fun of(quote: FxQuote) = QuoteResponse(
            quote.id,
            quote.ownerId,
            quote.rateId,
            quote.sellCurrency,
            quote.buyCurrency,
            quote.sellMinor,
            quote.buyMinor,
            quote.midBuyMinor,
            quote.midRate.toPlainString(),
            quote.customerRate.toPlainString(),
            quote.expiresAt,
            quote.usedEntryId
        )
    }
}

@RestController
@RequestMapping("/v1/fx")
class FxController(
    private val fx: FxService,
    private val idempotent: IdempotentRequests
) {
    @PostMapping("/rates")
    fun publishRate(
        caller: Caller,
        @Valid @RequestBody body: PublishRateRequest,
        request: HttpServletRequest
    ): ResponseEntity<JsonNode> = idempotent.run(caller, request, body) {
        val rate = fx.publishRate(caller, body.sellCurrency, body.buyCurrency, BigDecimal(body.midRate), body.spreadBps)
        ApiResult(HttpStatus.CREATED.value(), RateResponse.of(rate))
    }

    @GetMapping("/rates")
    fun currentRate(caller: Caller, @RequestParam sell: Currency, @RequestParam buy: Currency): RateResponse =
        RateResponse.of(fx.currentRate(caller, sell, buy))

    @PostMapping("/quotes")
    fun quote(
        caller: Caller,
        @Valid @RequestBody body: QuoteRequest,
        request: HttpServletRequest
    ): ResponseEntity<JsonNode> = idempotent.run(caller, request, body) {
        val command = QuoteCommand(body.ownerId, body.sellCurrency, body.buyCurrency, body.sellAmountMinor, body.buyAmountMinor)
        ApiResult(HttpStatus.CREATED.value(), QuoteResponse.of(fx.quote(caller, command)))
    }

    @PostMapping("/transfers")
    fun transfer(
        caller: Caller,
        @Valid @RequestBody body: FxTransferRequest,
        request: HttpServletRequest
    ): ResponseEntity<JsonNode> = idempotent.run(caller, request, body) {
        val command = FxTransferCommand(body.quoteId, body.fromAccountId, body.toAccountId)
        ApiResult(HttpStatus.CREATED.value(), fx.transfer(caller, command))
    }
}
