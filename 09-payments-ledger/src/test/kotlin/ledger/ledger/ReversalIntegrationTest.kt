package ledger.ledger

import ledger.domain.AccountStatus
import ledger.domain.Currency
import ledger.domain.SystemRole
import ledger.support.IntegrationTest
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.MvcResult
import java.util.UUID
import kotlin.test.assertEquals

class ReversalIntegrationTest : IntegrationTest() {
    private fun transfer(from: UUID, to: UUID, amount: Long): String {
        val result = post(
            "/v1/transfers",
            serviceKey,
            mapOf("fromAccountId" to from, "toAccountId" to to, "amountMinor" to amount, "currency" to "USD")
        )
        assertEquals(201, result.response.status, result.response.contentAsString)
        return json(result).path("id").asText()
    }

    private fun reverse(entryId: Any, reason: String = "customer dispute"): MvcResult =
        post("/v1/entries/$entryId/reverse", operatorKey, mapOf("reason" to reason))

    private fun expectationStatus(account: UUID): String =
        jdbc.sql("SELECT status FROM bank_expectations WHERE account_id = :a").param("a", account).query(String::class.java).single()

    @Test
    fun `reversing a transfer negates every posting`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        val original = transfer(a, b, 400)

        val result = reverse(original)

        assertEquals(201, result.response.status)
        val entry = json(result)
        assertEquals("reversal", entry.path("kind").asText())
        assertEquals(original, entry.path("reversesEntryId").asText())
        assertEquals("customer dispute", entry.path("reason").asText())
        assertEquals(listOf(400L, -400L), entry.path("postings").map { it.path("amountMinor").asLong() })
        assertEquals(1_000, balance(a).postedMinor)
        assertEquals(0, balance(b).postedMinor)
    }

    @Test
    fun `an entry is reversed at most once`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        val original = transfer(a, b, 400)
        assertEquals(201, reverse(original).response.status)

        val again = reverse(original)
        assertEquals(409, again.response.status)
        assertEquals("already_reversed", errorCode(again))
        assertEquals(1_000, balance(a).postedMinor)
    }

    @Test
    fun `deposits and reversals cannot be reversed`() {
        val a = wallet()
        val b = wallet()
        val deposit = fund(a, 1_000)
        val original = transfer(a, b, 100)
        val reversal = json(reverse(original)).path("id").asText()

        assertEquals("not_reversible", errorCode(reverse(deposit.id)))
        assertEquals("not_reversible", errorCode(reverse(reversal)))
        assertEquals(404, reverse(UUID.randomUUID()).response.status)
    }

    @Test
    fun `reversal fails when the recipient has spent the money`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        val original = transfer(a, b, 600)
        transfer(b, wallet(), 500)

        val result = reverse(original)

        assertEquals(422, result.response.status)
        assertEquals("insufficient_funds", errorCode(result))
        assertEquals(100, balance(b).postedMinor)
        assertEquals(0, jdbc.sql("SELECT count(*) FROM journal_entries WHERE kind = 'reversal'").query(Long::class.javaObjectType).single())
    }

    @Test
    fun `reversing a capture moves money back without reopening the hold`() {
        val wallet = wallet()
        val shop = merchant(feeBps = 250)
        fund(wallet, 10_000)
        val hold = json(
            post(
                "/v1/holds",
                serviceKey,
                mapOf("accountId" to wallet, "merchantAccountId" to shop, "amountMinor" to 1_000, "currency" to "USD")
            )
        ).path("id").asText()
        val captured = json(post("/v1/holds/$hold/capture", serviceKey, mapOf("amountMinor" to 1_000)))

        assertEquals(201, reverse(captured.path("captureEntryId").asText()).response.status)

        assertEquals(10_000, balance(wallet).postedMinor)
        assertEquals(0, balance(wallet).heldMinor)
        assertEquals(0, balance(shop).postedMinor)
        assertEquals(0, balance(systemAccount(SystemRole.FEES)).postedMinor)
        assertEquals("captured", json(get("/v1/holds/$hold", serviceKey)).path("status").asText())
    }

    @Test
    fun `reversing a withdrawal cancels its open expectation`() {
        val a = wallet()
        fund(a, 1_000)
        val withdrawal = json(post("/v1/withdrawals", serviceKey, mapOf("accountId" to a, "amountMinor" to 300, "currency" to "USD")))

        assertEquals(201, reverse(withdrawal.path("id").asText()).response.status)

        assertEquals("cancelled", expectationStatus(a))
        assertEquals(1_000, balance(a).postedMinor)
        assertEquals(0, balance(systemAccount(SystemRole.PAYOUT_CLEARING)).postedMinor)
    }

    @Test
    fun `a withdrawal whose expectation has matched is no longer reversible`() {
        val a = wallet()
        fund(a, 1_000)
        val withdrawal = json(post("/v1/withdrawals", serviceKey, mapOf("accountId" to a, "amountMinor" to 300, "currency" to "USD")))
        jdbc.sql("UPDATE bank_expectations SET status = 'matched' WHERE account_id = :a").param("a", a).update()

        assertEquals("not_reversible", errorCode(reverse(withdrawal.path("id").asText())))
        assertEquals(700, balance(a).postedMinor)
    }

    @Test
    fun `reversing into a closed account is refused while a frozen account may be debited`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        val first = transfer(a, b, 300)
        val second = transfer(a, b, 200)

        accounts.updateStatus(b, AccountStatus.FROZEN)
        assertEquals(201, reverse(first).response.status)
        assertEquals(200, balance(b).postedMinor)

        jdbc.sql("UPDATE accounts SET status = 'closed' WHERE id = :a").param("a", a).update()
        assertEquals("account_closed", errorCode(reverse(second)))
    }

    @Test
    fun `fx transfers can be reversed`() {
        post("/v1/fx/rates", operatorKey, mapOf("sellCurrency" to "USD", "buyCurrency" to "EUR", "midRate" to "0.92000000", "spreadBps" to 100))
        val owner = UUID.randomUUID()
        val usd = wallet(owner, Currency.USD)
        val eur = wallet(owner, Currency.EUR)
        fund(usd, 10_000)
        val quote = json(post("/v1/fx/quotes", serviceKey, mapOf("ownerId" to owner, "sellCurrency" to "USD", "buyCurrency" to "EUR", "sellAmountMinor" to 5_000)))
        val entry = json(post("/v1/fx/transfers", serviceKey, mapOf("quoteId" to quote.path("id").asText(), "fromAccountId" to usd, "toAccountId" to eur)))

        assertEquals(201, reverse(entry.path("id").asText()).response.status)
        assertEquals(10_000, balance(usd).postedMinor)
        assertEquals(0, balance(eur).postedMinor)
        assertEquals(0, balance(systemAccount(SystemRole.FX_RESIDUE, Currency.EUR)).postedMinor)
    }

    @Test
    fun `only operators reverse and a reason is required`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        val original = transfer(a, b, 100)
        assertEquals(403, post("/v1/entries/$original/reverse", serviceKey, mapOf("reason" to "x")).response.status)
        assertEquals(400, reverse(original, "").response.status)
        assertEquals(400, reverse(original, "x".repeat(201)).response.status)
        assertEquals(201, reverse(original, "x".repeat(200)).response.status)
    }
}
