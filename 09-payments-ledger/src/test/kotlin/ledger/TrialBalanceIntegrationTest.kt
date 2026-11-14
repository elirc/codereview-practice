package ledger

import ledger.domain.Currency
import ledger.domain.MinorUnits
import ledger.jobs.HoldExpiryJob
import ledger.jobs.ReconcileJob
import ledger.support.IntegrationTest
import ledger.support.StatementFiles
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.time.Instant
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TrialBalanceIntegrationTest : IntegrationTest() {
    @Autowired
    private lateinit var reconcileJob: ReconcileJob

    @Autowired
    private lateinit var expiryJob: HoldExpiryJob

    private fun ok(path: String, body: Any? = null): String {
        val result = post(path, serviceKey, body)
        assertTrue(result.response.status in 200..201, "$path: ${result.response.contentAsString}")
        return json(result).path("id").asText()
    }

    private fun operator(path: String, body: Any? = null) {
        val result = post(path, operatorKey, body)
        assertTrue(result.response.status in 200..201, "$path: ${result.response.contentAsString}")
    }

    @Test
    fun `a mixed day of activity leaves every currency balanced`() {
        val alice = UUID.randomUUID()
        val aliceUsd = wallet(alice, Currency.USD)
        val aliceEur = wallet(alice, Currency.EUR)
        val bob = wallet()
        val shop = merchant(feeBps = 250)
        val usd = { minor: Long -> MinorUnits.format(minor, Currency.USD) }

        val deposits = StatementFiles.csv(
            "BANK-USD", "USD", "2026-03-02", "0.00", usd(70_000),
            listOf(
                "S1,2026-03-02,${usd(50_000)},${accounts.get(aliceUsd).depositReference},",
                "S2,2026-03-02,${usd(20_000)},${accounts.get(bob).depositReference},"
            )
        )
        assertEquals(201, upload("BANK-USD", deposits).response.status)
        reconcileJob.runOnce(clock.instant())

        val transfer = ok("/v1/transfers", mapOf("fromAccountId" to aliceUsd, "toAccountId" to bob, "amountMinor" to 5_000, "currency" to "USD"))
        ok("/v1/transfers", mapOf("fromAccountId" to bob, "toAccountId" to shop, "amountMinor" to 3_000, "currency" to "USD"))

        val holdBody = { amount: Long, expires: Long ->
            mapOf("accountId" to aliceUsd, "merchantAccountId" to shop, "amountMinor" to amount, "currency" to "USD", "expiresInSeconds" to expires)
        }
        val captured = ok("/v1/holds", holdBody(4_000, 3_600))
        ok("/v1/holds/$captured/capture", mapOf("amountMinor" to 2_500))
        val released = ok("/v1/holds", holdBody(1_000, 3_600))
        ok("/v1/holds/$released/release")
        ok("/v1/holds", holdBody(700, 60))
        ok("/v1/holds", holdBody(300, 3_600))
        expiryJob.runOnce(Instant.parse("2026-03-02T10:05:00Z"))

        operator("/v1/fx/rates", mapOf("sellCurrency" to "USD", "buyCurrency" to "EUR", "midRate" to "0.91876543", "spreadBps" to 75))
        val quote = ok("/v1/fx/quotes", mapOf("ownerId" to alice, "sellCurrency" to "USD", "buyCurrency" to "EUR", "sellAmountMinor" to 10_001))
        ok("/v1/fx/transfers", mapOf("quoteId" to quote, "fromAccountId" to aliceUsd, "toAccountId" to aliceEur))

        val withdrawal = ok("/v1/withdrawals", mapOf("accountId" to bob, "amountMinor" to 2_000, "currency" to "USD"))
        val reference = jdbc.sql("SELECT reference FROM bank_expectations WHERE source_entry_id = :id")
            .param("id", UUID.fromString(withdrawal)).query(String::class.java).single()
        operator("/v1/entries/$transfer/reverse", mapOf("reason" to "sent in error"))

        at("2026-03-03T00:20:00Z")
        operator("/v1/settlements", mapOf("businessDate" to "2026-03-02", "currency" to "USD"))
        val payouts = StatementFiles.csv(
            "BANK-USD", "USD", "2026-03-03", usd(70_000), usd(68_000),
            listOf("S3,2026-03-03,${usd(-2_000)},$reference,")
        )
        assertEquals(201, upload("BANK-USD", payouts).response.status)
        reconcileJob.runOnce(clock.instant())

        val report = json(get("/v1/trial-balance", auditorKey))

        assertTrue(report.path("balanced").asBoolean(), report.toString())
        report.path("currencies").forEach { currency ->
            assertEquals(0, currency.path("postedSumMinor").asLong(), currency.toString())
            assertEquals(0, currency.path("postingsSumMinor").asLong(), currency.toString())
            assertEquals(0, currency.path("driftingAccounts").size(), currency.toString())
            assertEquals(0, currency.path("heldDriftingAccounts").size(), currency.toString())
        }
        assertEquals(300, balance(aliceUsd).heldMinor)
    }

    @Test
    fun `a balance changed outside the ledger shows up as drift`() {
        val wallet = wallet()
        fund(wallet, 1_000)
        jdbc.sql("UPDATE account_balances SET posted_minor = posted_minor + 5, held_minor = 3 WHERE account_id = :id")
            .param("id", wallet).update()

        val report = json(get("/v1/trial-balance", operatorKey))

        assertFalse(report.path("balanced").asBoolean())
        val usdLine = report.path("currencies").single { it.path("currency").asText() == "USD" }
        assertEquals(5, usdLine.path("postedSumMinor").asLong())
        assertEquals(0, usdLine.path("postingsSumMinor").asLong())
        assertEquals(wallet.toString(), usdLine.path("driftingAccounts")[0].path("accountId").asText())
        assertEquals(1_000, usdLine.path("driftingAccounts")[0].path("postingsSumMinor").asLong())
        assertEquals(3, usdLine.path("heldDriftingAccounts")[0].path("heldMinor").asLong())
        assertEquals(403, get("/v1/trial-balance", serviceKey).response.status)
    }
}
