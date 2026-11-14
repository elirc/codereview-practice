package ledger

import ledger.domain.Currency
import ledger.holds.HoldService
import ledger.jobs.HoldExpiryJob
import ledger.limits.LimitService
import ledger.support.IntegrationTest
import org.junit.jupiter.api.RepeatedTest
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.test.web.servlet.MvcResult
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ConcurrentOperationsTest : IntegrationTest() {
    @Autowired
    private lateinit var limits: LimitService

    @Autowired
    private lateinit var holds: HoldService

    @Autowired
    private lateinit var expiryJob: HoldExpiryJob

    private val today: LocalDate = LocalDate.parse("2026-03-02")

    private fun transfer(from: UUID, to: UUID, amount: Long, key: String = UUID.randomUUID().toString()): MvcResult =
        post("/v1/transfers", serviceKey, mapOf("fromAccountId" to from, "toAccountId" to to, "amountMinor" to amount, "currency" to "USD"), key)

    private fun authorize(wallet: UUID, merchant: UUID, amount: Long, expiresIn: Long = 604_800): MvcResult =
        post(
            "/v1/holds",
            serviceKey,
            mapOf("accountId" to wallet, "merchantAccountId" to merchant, "amountMinor" to amount, "currency" to "USD", "expiresInSeconds" to expiresIn)
        )

    private fun statuses(results: List<MvcResult>): List<Int> = results.map { it.response.status }.sorted()

    @RepeatedTest(3)
    fun `two transfers that together exceed the balance leave exactly one succeeding`() {
        val wallet = wallet()
        fund(wallet, 1_000)
        val targets = listOf(wallet(), wallet())

        val results = simultaneously(2) { i -> transfer(wallet, targets[i], 600) }

        assertEquals(listOf(201, 422), statuses(results))
        assertEquals("insufficient_funds", errorCode(results.single { it.response.status == 422 }))
        assertEquals(400, balance(wallet).postedMinor)
    }

    @Test
    fun `many transfers never take a wallet below zero`() {
        val wallet = wallet()
        fund(wallet, 1_000)
        val results = simultaneously(8) { transfer(wallet, wallet(), 300) }

        assertEquals(3, results.count { it.response.status == 201 })
        assertEquals(5, results.count { it.response.status == 422 })
        assertEquals(100, balance(wallet).availableMinor)
    }

    @Test
    fun `transfers in opposite directions between two wallets all complete`() {
        val a = wallet()
        val b = wallet()
        fund(a, 100_000)
        fund(b, 100_000)

        val results = simultaneously(2) { i ->
            (1..15).map { if (i == 0) transfer(a, b, 10) else transfer(b, a, 10) }
        }.flatten()

        assertTrue(results.all { it.response.status == 201 }, results.map { it.response.status }.toString())
        assertEquals(100_000, balance(a).postedMinor)
        assertEquals(100_000, balance(b).postedMinor)
    }

    @RepeatedTest(3)
    fun `a hold and a transfer competing for the same money leave available at or above zero`() {
        val wallet = wallet()
        val shop = merchant()
        fund(wallet, 1_000)

        val results = simultaneously(2) { i -> if (i == 0) authorize(wallet, shop, 700) else transfer(wallet, wallet(), 700) }

        assertEquals(1, results.count { it.response.status == 201 })
        val row = balance(wallet)
        assertTrue(row.availableMinor >= 0)
        assertEquals(300, row.availableMinor)
    }

    @RepeatedTest(3)
    fun `capture and release of one hold resolve to a single outcome`() {
        val wallet = wallet()
        val owner = ownerOf(wallet)
        fund(wallet, 5_000)
        val hold = json(authorize(wallet, merchant(), 2_000)).path("id").asText()

        val results = simultaneously(2) { i ->
            if (i == 0) post("/v1/holds/$hold/capture", serviceKey, mapOf("amountMinor" to 1_500)) else post("/v1/holds/$hold/release", serviceKey)
        }

        assertEquals(listOf(200, 409), statuses(results))
        assertEquals(0, balance(wallet).heldMinor)
        val captured = results[0].response.status == 200
        assertEquals(if (captured) 3_500 else 5_000, balance(wallet).postedMinor)
        assertEquals(if (captured) 1_500 else 0, limits.usage(owner, Currency.USD, today))
    }

    @RepeatedTest(3)
    fun `capture just before expiry and the expiry job resolve to a single outcome`() {
        val wallet = wallet()
        val owner = ownerOf(wallet)
        fund(wallet, 5_000)
        val hold = json(authorize(wallet, merchant(), 2_000, expiresIn = 60)).path("id").asText()
        val expiry = Instant.parse("2026-03-02T10:01:00Z")
        clock.set(expiry.minusMillis(1))

        val results = simultaneously(2) { i ->
            if (i == 0) post("/v1/holds/$hold/capture", serviceKey, mapOf("amountMinor" to 2_000)).response.status else expiryJob.runOnce(expiry)
        }

        val state = holds.get(serviceKey.caller, UUID.fromString(hold))
        assertEquals(0, balance(wallet).heldMinor)
        if (results[0] == 200) {
            assertEquals(0, results[1])
            assertEquals("captured", state.status.wire)
            assertEquals(2_000, limits.usage(owner, Currency.USD, today))
        } else {
            assertEquals(1, results[1])
            assertEquals("expired", state.status.wire)
            assertEquals(0, limits.usage(owner, Currency.USD, today))
        }
    }

    @RepeatedTest(3)
    fun `one owner spending from two accounts at once stays within the daily limit`() {
        val owner = UUID.randomUUID()
        val wallet = wallet(owner)
        val shop = merchant(owner)
        fund(wallet, 10_000)
        fund(shop, 10_000)
        limits.setLimit(operatorKey.caller, owner, Currency.USD, 1_000)

        val results = simultaneously(2) { i -> transfer(if (i == 0) wallet else shop, wallet(), 600) }

        assertEquals(listOf(201, 422), statuses(results))
        assertEquals("daily_limit_exceeded", errorCode(results.single { it.response.status == 422 }))
        assertEquals(600, limits.usage(owner, Currency.USD, today))
    }

    @RepeatedTest(3)
    fun `reversing one entry twice at once posts one reversal`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        val entry = json(transfer(a, b, 400)).path("id").asText()

        val results = simultaneously(2) { post("/v1/entries/$entry/reverse", operatorKey, mapOf("reason" to "duplicate charge")) }

        assertEquals(listOf(201, 409), statuses(results))
        assertEquals("already_reversed", errorCode(results.single { it.response.status == 409 }))
        assertEquals(1_000, balance(a).postedMinor)
    }

    @RepeatedTest(3)
    fun `one quote used twice at once converts once`() {
        post("/v1/fx/rates", operatorKey, mapOf("sellCurrency" to "USD", "buyCurrency" to "EUR", "midRate" to "0.92000000", "spreadBps" to 50))
        val owner = UUID.randomUUID()
        val usd = wallet(owner, Currency.USD)
        val eur = wallet(owner, Currency.EUR)
        fund(usd, 10_000)
        val quote = json(
            post("/v1/fx/quotes", serviceKey, mapOf("ownerId" to owner, "sellCurrency" to "USD", "buyCurrency" to "EUR", "sellAmountMinor" to 1_000))
        ).path("id").asText()

        val results = simultaneously(2) {
            post("/v1/fx/transfers", serviceKey, mapOf("quoteId" to quote, "fromAccountId" to usd, "toAccountId" to eur))
        }

        assertEquals(listOf(201, 409), statuses(results))
        assertEquals("quote_already_used", errorCode(results.single { it.response.status == 409 }))
        assertEquals(9_000, balance(usd).postedMinor)
    }

    @Test
    fun `the same transfer key sent at once posts once and both callers get the same answer`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)

        val results = simultaneously(4) { transfer(a, b, 250, key = "parallel-transfer-1") }

        assertEquals(listOf(201, 201, 201, 201), statuses(results))
        assertEquals(1, results.map { json(it) }.toSet().size)
        assertEquals(750, balance(a).postedMinor)
    }
}
