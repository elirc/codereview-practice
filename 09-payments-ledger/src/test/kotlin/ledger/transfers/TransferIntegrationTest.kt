package ledger.transfers

import ledger.domain.AccountStatus
import ledger.domain.Currency
import ledger.domain.SystemRole
import ledger.limits.LimitService
import ledger.support.IntegrationTest
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.time.LocalDate
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TransferIntegrationTest : IntegrationTest() {
    @Autowired
    private lateinit var limits: LimitService

    private fun transfer(from: UUID, to: UUID, amount: Any, currency: String = "USD", key: String = UUID.randomUUID().toString()) =
        post(
            "/v1/transfers",
            serviceKey,
            mapOf("fromAccountId" to from, "toAccountId" to to, "amountMinor" to amount, "currency" to currency),
            key
        )

    private fun withdraw(account: UUID, amount: Long, currency: String = "USD") =
        post("/v1/withdrawals", serviceKey, mapOf("accountId" to account, "amountMinor" to amount, "currency" to currency))

    @Test
    fun `transfer returns the entry and moves the money`() {
        val a = wallet()
        val b = wallet()
        fund(a, 5_000)

        val result = transfer(a, b, 1_250)

        assertEquals(201, result.response.status)
        val entry = json(result)
        assertEquals("transfer", entry.path("kind").asText())
        assertEquals(listOf(-1_250L, 1_250L), entry.path("postings").map { it.path("amountMinor").asLong() })
        assertEquals(3_750, balance(a).postedMinor)
        assertEquals(1_250, balance(b).postedMinor)
    }

    @Test
    fun `the full available balance can be sent but not one unit more`() {
        val a = wallet()
        val b = wallet()
        fund(a, 10_000)

        val over = transfer(a, b, 10_001)
        assertEquals(422, over.response.status)
        assertEquals("insufficient_funds", errorCode(over))
        assertEquals(10_000, json(over).path("error").path("details").path("availableMinor").asLong())
        assertEquals(a.toString(), json(over).path("error").path("details").path("accountId").asText())

        assertEquals(201, transfer(a, b, 10_000).response.status)
        assertEquals(0, balance(a).availableMinor)
    }

    @Test
    fun `transfer rules on accounts and currency`() {
        val a = wallet()
        val euro = wallet(currency = Currency.EUR)
        val b = wallet()
        fund(a, 1_000)

        assertEquals("same_account", errorCode(transfer(a, a, 10)))
        assertEquals("currency_mismatch", errorCode(transfer(a, euro, 10)))
        assertEquals("currency_mismatch", errorCode(transfer(a, b, 10, "EUR")))
        assertEquals("invalid_account_type", errorCode(transfer(a, systemAccount(SystemRole.FEES), 10)))
        assertEquals("invalid_account_type", errorCode(transfer(systemAccount(SystemRole.BANK_CASH), b, 10)))
        assertEquals(404, transfer(a, UUID.randomUUID(), 10).response.status)
        assertEquals(1, entryCount())
    }

    @Test
    fun `amounts must be positive json integers`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        val raw = listOf("10.5", "1e3", "\"100\"", "0", "-5", "null", "true")
        raw.forEach { amount ->
            val result = post(
                "/v1/transfers",
                serviceKey,
                """{"fromAccountId":"$a","toAccountId":"$b","amountMinor":$amount,"currency":"USD"}"""
            )
            assertEquals(400, result.response.status, amount)
            assertEquals("validation_failed", errorCode(result), amount)
        }
        val unknownField = post(
            "/v1/transfers",
            serviceKey,
            """{"fromAccountId":"$a","toAccountId":"$b","amountMinor":5,"currency":"USD","memo":"x"}"""
        )
        assertEquals(400, unknownField.response.status)
        assertEquals(1, entryCount())
    }

    @Test
    fun `frozen wallet cannot send but can receive`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        fund(b, 1_000)
        accounts.updateStatus(a, AccountStatus.FROZEN)

        assertEquals("account_frozen", errorCode(transfer(a, b, 100)))
        assertEquals(201, transfer(b, a, 100).response.status)
        assertEquals(1_100, balance(a).postedMinor)
    }

    @Test
    fun `only service keys may move money`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        val body = mapOf("fromAccountId" to a, "toAccountId" to b, "amountMinor" to 1, "currency" to "USD")
        assertEquals(403, post("/v1/transfers", operatorKey, body).response.status)
        assertEquals(403, post("/v1/transfers", auditorKey, body).response.status)
    }

    @Test
    fun `daily limit allows exactly the limit and reports what remains`() {
        val owner = UUID.randomUUID()
        val a = wallet(owner)
        val b = wallet()
        fund(a, 100_000)
        assertEquals(200, put("/v1/owners/$owner/limits/USD", operatorKey, mapOf("dailyOutMinor" to 5_000)).response.status)

        assertEquals(201, transfer(a, b, 3_000).response.status)
        val over = transfer(a, b, 2_001)
        assertEquals(422, over.response.status)
        assertEquals("daily_limit_exceeded", errorCode(over))
        assertEquals(2_000, json(over).path("error").path("details").path("remainingMinor").asLong())
        assertEquals(201, transfer(a, b, 2_000).response.status)
        assertEquals(5_000, limits.usage(owner, Currency.USD, LocalDate.parse("2026-03-02")))

        at("2026-03-03T00:00:00Z")
        assertEquals(201, transfer(a, b, 5_000).response.status)
    }

    @Test
    fun `transfers between accounts of one owner do not use the limit`() {
        val owner = UUID.randomUUID()
        val wallet = wallet(owner)
        val shop = merchant(owner)
        fund(wallet, 50_000)
        limits.setLimit(operatorKey.caller, owner, Currency.USD, 100)

        assertEquals(201, transfer(wallet, shop, 40_000).response.status)
        assertEquals(0, limits.usage(owner, Currency.USD, LocalDate.parse("2026-03-02")))
    }

    @Test
    fun `default limit comes from configuration`() {
        val owner = UUID.randomUUID()
        val a = wallet(owner)
        fund(a, 2_000_000)
        val result = transfer(a, wallet(), 1_000_001)
        assertEquals("daily_limit_exceeded", errorCode(result))
        assertEquals(1_000_000, json(result).path("error").path("details").path("remainingMinor").asLong())
    }

    @Test
    fun `setting limits is for operators and is not idempotency keyed`() {
        val owner = UUID.randomUUID()
        assertEquals(403, put("/v1/owners/$owner/limits/USD", serviceKey, mapOf("dailyOutMinor" to 1)).response.status)
        assertEquals(400, put("/v1/owners/$owner/limits/USD", operatorKey, mapOf("dailyOutMinor" to -1)).response.status)
        assertEquals(400, put("/v1/owners/$owner/limits/CHF", operatorKey, mapOf("dailyOutMinor" to 1)).response.status)
        val ok = put("/v1/owners/$owner/limits/JPY", operatorKey, mapOf("dailyOutMinor" to 70_000))
        assertEquals(200, ok.response.status)
        assertEquals(70_000, json(ok).path("dailyOutMinor").asLong())
        assertEquals(70_000, limits.limitFor(owner, Currency.JPY))
    }

    @Test
    fun `withdrawal moves money to payout clearing and opens an expectation`() {
        val owner = UUID.randomUUID()
        val a = wallet(owner)
        fund(a, 9_000)

        val result = withdraw(a, 4_000)

        assertEquals(201, result.response.status)
        assertEquals("withdrawal", json(result).path("kind").asText())
        assertEquals(5_000, balance(a).postedMinor)
        assertEquals(4_000, balance(systemAccount(SystemRole.PAYOUT_CLEARING)).postedMinor)
        val reference = jdbc.sql("SELECT reference FROM bank_expectations WHERE account_id = :a AND status = 'open'")
            .param("a", a).query(String::class.java).single()
        assertTrue(Regex("WDR-[A-Z2-7]{12}").matches(reference))
        assertEquals(1, outboxCount("payout.created"))
        assertEquals(4_000, limits.usage(owner, Currency.USD, LocalDate.parse("2026-03-02")))
    }

    @Test
    fun `withdrawal over the balance posts nothing and opens nothing`() {
        val a = wallet()
        fund(a, 100)
        assertEquals("insufficient_funds", errorCode(withdraw(a, 101)))
        assertEquals(0, jdbc.sql("SELECT count(*) FROM bank_expectations").query(Long::class.javaObjectType).single())
        assertEquals(0, limits.usage(ownerOf(a), Currency.USD, LocalDate.parse("2026-03-02")))
    }

    @Test
    fun `a stored insufficient funds answer is replayed after funding while a new key succeeds`() {
        val a = wallet()
        val b = wallet()
        fund(a, 100)

        val first = transfer(a, b, 500, key = "pay-0000001")
        assertEquals(422, first.response.status)
        fund(a, 1_000)

        val replay = transfer(a, b, 500, key = "pay-0000001")
        assertEquals(422, replay.response.status)
        assertEquals("true", replay.response.getHeader("Idempotent-Replay"))
        assertEquals("insufficient_funds", errorCode(replay))

        assertEquals(201, transfer(a, b, 500, key = "pay-0000002").response.status)
    }

    @Test
    fun `a repeated transfer posts once`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        val first = transfer(a, b, 300, key = "pay-0000003")
        val second = transfer(a, b, 300, key = "pay-0000003")
        assertEquals(json(first), json(second))
        assertEquals(700, balance(a).postedMinor)
        assertEquals(2, entryCount())
    }
}
