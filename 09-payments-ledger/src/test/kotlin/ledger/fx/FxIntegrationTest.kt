package ledger.fx

import ledger.domain.Currency
import ledger.domain.SystemRole
import ledger.limits.LimitService
import ledger.support.IntegrationTest
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.test.web.servlet.MvcResult
import java.time.Duration
import java.time.LocalDate
import java.util.UUID
import kotlin.test.assertEquals

class FxIntegrationTest : IntegrationTest() {
    @Autowired
    private lateinit var limits: LimitService

    private fun publish(sell: String, buy: String, mid: String, spread: Int = 50): MvcResult =
        post("/v1/fx/rates", operatorKey, mapOf("sellCurrency" to sell, "buyCurrency" to buy, "midRate" to mid, "spreadBps" to spread))

    private fun quote(owner: UUID, sell: String = "USD", buy: String = "JPY", sellAmount: Long? = null, buyAmount: Long? = null): MvcResult {
        val body = mutableMapOf<String, Any>("ownerId" to owner, "sellCurrency" to sell, "buyCurrency" to buy)
        if (sellAmount != null) body["sellAmountMinor"] = sellAmount
        if (buyAmount != null) body["buyAmountMinor"] = buyAmount
        return post("/v1/fx/quotes", serviceKey, body)
    }

    private fun quoteId(result: MvcResult): String {
        assertEquals(201, result.response.status, result.response.contentAsString)
        return json(result).path("id").asText()
    }

    private fun convert(quoteId: String, from: UUID, to: UUID): MvcResult =
        post("/v1/fx/transfers", serviceKey, mapOf("quoteId" to quoteId, "fromAccountId" to from, "toAccountId" to to))

    private data class Wallets(val owner: UUID, val usd: UUID, val jpy: UUID)

    private fun funded(): Wallets {
        val owner = UUID.randomUUID()
        val usd = wallet(owner, Currency.USD)
        val jpy = wallet(owner, Currency.JPY)
        fund(usd, 100_000)
        return Wallets(owner, usd, jpy)
    }

    @Test
    fun `published rates are append only and the newest one is current`() {
        assertEquals(201, publish("USD", "JPY", "150.00000000").response.status)
        clock.advance(Duration.ofSeconds(5))
        publish("USD", "JPY", "151.23456789")
        val current = json(get("/v1/fx/rates?sell=USD&buy=JPY", auditorKey))
        assertEquals("151.23456789", current.path("midRate").asText())
        assertEquals(50, current.path("spreadBps").asInt())
        assertEquals(404, get("/v1/fx/rates?sell=JPY&buy=USD", auditorKey).response.status)
        assertEquals(2, jdbc.sql("SELECT count(*) FROM fx_rates").query(Long::class.javaObjectType).single())
    }

    @Test
    fun `publishing the current rate again keeps a single row`() {
        val first = json(publish("USD", "JPY", "151.23456789"))
        clock.advance(Duration.ofSeconds(60))
        val again = publish("USD", "JPY", "151.23456789")
        assertEquals(201, again.response.status)
        assertEquals(first.path("id").asText(), json(again).path("id").asText())
        assertEquals(1, jdbc.sql("SELECT count(*) FROM fx_rates").query(Long::class.javaObjectType).single())

        publish("USD", "JPY", "151.23456789", spread = 40)
        assertEquals(40, json(get("/v1/fx/rates?sell=USD&buy=JPY", auditorKey)).path("spreadBps").asInt())
        assertEquals(2, jdbc.sql("SELECT count(*) FROM fx_rates").query(Long::class.javaObjectType).single())
    }

    @Test
    fun `rate input is validated`() {
        assertEquals(400, publish("USD", "USD", "1.00000000").response.status)
        assertEquals(400, publish("USD", "EUR", "1.123456789").response.status)
        assertEquals(400, publish("USD", "EUR", "0").response.status)
        assertEquals(400, publish("USD", "EUR", "1.5", spread = 10_000).response.status)
        val numeric = post("/v1/fx/rates", operatorKey, """{"sellCurrency":"USD","buyCurrency":"EUR","midRate":0.9,"spreadBps":10}""")
        assertEquals(400, numeric.response.status)
        assertEquals(403, post("/v1/fx/rates", serviceKey, mapOf("sellCurrency" to "USD", "buyCurrency" to "EUR", "midRate" to "0.9", "spreadBps" to 1)).response.status)
    }

    @Test
    fun `ten dollars buys 1504 yen and the difference to mid goes to residue`() {
        publish("USD", "JPY", "151.23456789", 50)
        val accounts = funded()

        val quote = json(quote(accounts.owner, sellAmount = 1_000))
        assertEquals(1_000, quote.path("sellMinor").asLong())
        assertEquals(1_504, quote.path("buyMinor").asLong())
        assertEquals(1_512, quote.path("midBuyMinor").asLong())
        assertEquals("150.47839505", quote.path("customerRate").asText())
        assertEquals("2026-03-02T10:00:30Z", quote.path("expiresAt").asText())

        val result = convert(quote.path("id").asText(), accounts.usd, accounts.jpy)
        assertEquals(201, result.response.status)
        assertEquals("fx_transfer", json(result).path("kind").asText())
        assertEquals(5, json(result).path("postings").size())
        assertEquals(99_000, balance(accounts.usd).postedMinor)
        assertEquals(1_504, balance(accounts.jpy).postedMinor)
        assertEquals(1_000, balance(systemAccount(SystemRole.FX_POSITION, Currency.USD)).postedMinor)
        assertEquals(-1_512, balance(systemAccount(SystemRole.FX_POSITION, Currency.JPY)).postedMinor)
        assertEquals(8, balance(systemAccount(SystemRole.FX_RESIDUE, Currency.JPY)).postedMinor)
    }

    @Test
    fun `a fixed buy amount rounds the sale up and posts no residue when mid matches`() {
        publish("USD", "JPY", "151.23456789", 0)
        val accounts = funded()

        val quote = json(quote(accounts.owner, buyAmount = 1_504))
        assertEquals(995, quote.path("sellMinor").asLong())
        assertEquals(1_504, quote.path("midBuyMinor").asLong())

        val entry = json(convert(quote.path("id").asText(), accounts.usd, accounts.jpy))
        assertEquals(4, entry.path("postings").size())
        assertEquals(0, balance(systemAccount(SystemRole.FX_RESIDUE, Currency.JPY)).postedMinor)
    }

    @Test
    fun `a rate published after the quote does not change the posted amounts`() {
        publish("USD", "JPY", "151.23456789", 50)
        val accounts = funded()
        val id = quoteId(quote(accounts.owner, sellAmount = 1_000))

        publish("USD", "JPY", "120.00000000", 0)
        convert(id, accounts.usd, accounts.jpy)

        assertEquals(1_504, balance(accounts.jpy).postedMinor)
    }

    @Test
    fun `a quote is usable until just before it expires`() {
        publish("USD", "JPY", "151.23456789", 50)
        val accounts = funded()
        val late = quoteId(quote(accounts.owner, sellAmount = 1_000))
        val onTime = quoteId(quote(accounts.owner, sellAmount = 1_000))

        at("2026-03-02T10:00:30Z")
        val expired = convert(late, accounts.usd, accounts.jpy)
        assertEquals(422, expired.response.status)
        assertEquals("quote_expired", errorCode(expired))

        at("2026-03-02T10:00:29.999Z")
        assertEquals(201, convert(onTime, accounts.usd, accounts.jpy).response.status)
    }

    @Test
    fun `a quote posts once`() {
        publish("USD", "JPY", "151.23456789", 50)
        val accounts = funded()
        val id = quoteId(quote(accounts.owner, sellAmount = 1_000))

        assertEquals(201, convert(id, accounts.usd, accounts.jpy).response.status)
        val again = convert(id, accounts.usd, accounts.jpy)
        assertEquals(409, again.response.status)
        assertEquals("quote_already_used", errorCode(again))
        assertEquals(1_504, balance(accounts.jpy).postedMinor)
    }

    @Test
    fun `quotes between different owners or currencies are refused`() {
        publish("USD", "JPY", "151.23456789", 50)
        val accounts = funded()
        val strangerJpy = wallet(currency = Currency.JPY)
        val id = quoteId(quote(accounts.owner, sellAmount = 1_000))

        assertEquals("quote_owner_mismatch", errorCode(convert(id, accounts.usd, strangerJpy)))
        assertEquals("currency_mismatch", errorCode(convert(id, accounts.jpy, accounts.usd)))
        assertEquals(100_000, balance(accounts.usd).postedMinor)
        assertEquals(201, convert(id, accounts.usd, accounts.jpy).response.status)
    }

    @Test
    fun `quotes need a fresh rate for exactly the requested pair`() {
        val owner = UUID.randomUUID()
        publish("JPY", "USD", "0.00661227", 50)
        assertEquals("rate_unavailable", errorCode(quote(owner, "USD", "JPY", sellAmount = 1_000)))

        publish("USD", "JPY", "151.23456789", 50)
        clock.advance(Duration.ofSeconds(3_600))
        assertEquals(201, quote(owner, sellAmount = 1_000).response.status)
        clock.advance(Duration.ofSeconds(1))
        assertEquals("rate_stale", errorCode(quote(owner, sellAmount = 1_000)))
    }

    @Test
    fun `quotes take exactly one amount and refuse amounts that round to zero`() {
        val owner = UUID.randomUUID()
        publish("JPY", "USD", "0.00661227", 0)
        assertEquals(400, quote(owner, "JPY", "USD").response.status)
        assertEquals(400, quote(owner, "JPY", "USD", sellAmount = 10, buyAmount = 10).response.status)
        assertEquals("amount_too_small", errorCode(quote(owner, "JPY", "USD", sellAmount = 1)))
        assertEquals(201, quote(owner, "JPY", "USD", sellAmount = 10_000).response.status)
    }

    @Test
    fun `fx transfers do not count against the daily limit`() {
        publish("USD", "JPY", "151.23456789", 50)
        val accounts = funded()
        limits.setLimit(operatorKey.caller, accounts.owner, Currency.USD, 0)
        convert(quoteId(quote(accounts.owner, sellAmount = 50_000)), accounts.usd, accounts.jpy)
        assertEquals(50_000, balance(accounts.usd).postedMinor)
        assertEquals(0, limits.usage(accounts.owner, Currency.USD, LocalDate.parse("2026-03-02")))
    }
}
