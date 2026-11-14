package ledger.holds

import ledger.domain.AccountStatus
import ledger.domain.Currency
import ledger.domain.Role
import ledger.domain.SystemRole
import ledger.jobs.HoldExpiryJob
import ledger.limits.LimitService
import ledger.support.IntegrationTest
import ledger.support.TestKey
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.test.web.servlet.MvcResult
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import kotlin.test.assertEquals

class HoldIntegrationTest : IntegrationTest() {
    @Autowired
    private lateinit var limits: LimitService

    @Autowired
    private lateinit var expiryJob: HoldExpiryJob

    private val day1: LocalDate = LocalDate.parse("2026-03-02")

    private fun authorize(wallet: UUID, merchant: UUID, amount: Long, expiresIn: Long? = null): MvcResult {
        val body = mutableMapOf<String, Any>(
            "accountId" to wallet,
            "merchantAccountId" to merchant,
            "amountMinor" to amount,
            "currency" to "USD"
        )
        if (expiresIn != null) body["expiresInSeconds"] = expiresIn
        return post("/v1/holds", serviceKey, body)
    }

    private fun authorized(wallet: UUID, merchant: UUID, amount: Long, expiresIn: Long? = null): UUID {
        val result = authorize(wallet, merchant, amount, expiresIn)
        assertEquals(201, result.response.status, result.response.contentAsString)
        return UUID.fromString(json(result).path("id").asText())
    }

    private fun capture(holdId: UUID, amount: Long, key: TestKey = serviceKey) =
        post("/v1/holds/$holdId/capture", key, mapOf("amountMinor" to amount))

    private fun release(holdId: UUID, key: TestKey = serviceKey) = post("/v1/holds/$holdId/release", key)

    private fun transfer(from: UUID, to: UUID, amount: Long) =
        post("/v1/transfers", serviceKey, mapOf("fromAccountId" to from, "toAccountId" to to, "amountMinor" to amount, "currency" to "USD"))

    @Test
    fun `an active hold reduces what a transfer can spend`() {
        val wallet = wallet()
        val shop = merchant()
        fund(wallet, 10_000)
        authorized(wallet, shop, 6_000)

        assertEquals(10_000, balance(wallet).postedMinor)
        assertEquals(6_000, balance(wallet).heldMinor)
        assertEquals("insufficient_funds", errorCode(transfer(wallet, wallet(), 4_001)))
        assertEquals(201, transfer(wallet, wallet(), 4_000).response.status)
    }

    @Test
    fun `authorisation needs available funds and an active merchant in the same currency`() {
        val wallet = wallet()
        val shop = merchant()
        fund(wallet, 1_000)

        assertEquals("insufficient_funds", errorCode(authorize(wallet, shop, 1_001)))
        assertEquals("invalid_account_type", errorCode(authorize(shop, wallet, 10)))
        assertEquals("currency_mismatch", errorCode(authorize(wallet, merchant(currency = Currency.EUR), 10)))
        accounts.updateStatus(shop, AccountStatus.FROZEN)
        assertEquals("account_frozen", errorCode(authorize(wallet, shop, 10)))
        assertEquals(400, authorize(wallet, shop, 10, expiresIn = 59).response.status)
        assertEquals(400, authorize(wallet, shop, 10, expiresIn = 604_801).response.status)
        assertEquals(0, balance(wallet).heldMinor)
    }

    @Test
    fun `hold expiry defaults to seven days`() {
        val wallet = wallet()
        fund(wallet, 1_000)
        val hold = json(authorize(wallet, merchant(), 100))
        assertEquals("2026-03-09T10:00:00Z", hold.path("expiresAt").asText())
        assertEquals("2026-03-02", hold.path("authorizedOn").asText())
        assertEquals("active", hold.path("status").asText())
    }

    @Test
    fun `a partial capture releases the remainder in the same step`() {
        val wallet = wallet()
        val shop = merchant()
        fund(wallet, 10_000)
        val hold = authorized(wallet, shop, 6_000)

        val result = capture(hold, 2_500)

        assertEquals(200, result.response.status)
        assertEquals("captured", json(result).path("status").asText())
        assertEquals(2_500, json(result).path("capturedMinor").asLong())
        assertEquals(7_500, balance(wallet).postedMinor)
        assertEquals(0, balance(wallet).heldMinor)
        assertEquals(2_500, balance(shop).postedMinor)
        assertEquals("hold_not_active", errorCode(capture(hold, 100)))
        assertEquals(409, capture(hold, 100).response.status)
    }

    @Test
    fun `capture larger than the hold is refused`() {
        val wallet = wallet()
        fund(wallet, 10_000)
        val hold = authorized(wallet, merchant(), 1_000)
        val result = capture(hold, 1_001)
        assertEquals(422, result.response.status)
        assertEquals("capture_exceeds_hold", errorCode(result))
        assertEquals(400, capture(hold, 0).response.status)
        assertEquals(1_000, balance(wallet).heldMinor)
    }

    @Test
    fun `capture fees round half to even and a zero fee posts no fee line`() {
        val shop = merchant(feeBps = 250)
        val wallet = wallet()
        fund(wallet, 10_000)
        val fees = systemAccount(SystemRole.FEES)

        listOf(60L to 2L, 100L to 2L, 20L to 0L).forEach { (amount, fee) ->
            val before = balance(fees).postedMinor
            val shopBefore = balance(shop).postedMinor
            val hold = authorized(wallet, shop, amount)
            val captured = json(capture(hold, amount))
            val entry = json(get("/v1/entries/${captured.path("captureEntryId").asText()}", auditorKey))
            assertEquals(fee, balance(fees).postedMinor - before, "fee on $amount")
            assertEquals(amount - fee, balance(shop).postedMinor - shopBefore)
            assertEquals(if (fee == 0L) 2 else 3, entry.path("postings").size(), "lines on $amount")
        }
    }

    @Test
    fun `capture at the expiry instant is refused while one millisecond earlier succeeds`() {
        val wallet = wallet()
        val shop = merchant()
        fund(wallet, 10_000)
        val late = authorized(wallet, shop, 1_000, expiresIn = 60)
        val onTime = authorized(wallet, shop, 1_000, expiresIn = 60)
        val expiry = Instant.parse("2026-03-02T10:01:00Z")

        clock.set(expiry)
        val refused = capture(late, 500)
        assertEquals(409, refused.response.status)
        assertEquals("hold_expired", errorCode(refused))

        clock.set(expiry.minusMillis(1))
        assertEquals(200, capture(onTime, 500).response.status)

        clock.set(expiry.plus(Duration.ofDays(3)))
        assertEquals("hold_expired", errorCode(capture(late, 500)))
        assertEquals(200, release(late).response.status)
        assertEquals(0, balance(wallet).heldMinor)
    }

    @Test
    fun `expiry job expires due holds once and returns their limit`() {
        val wallet = wallet()
        val owner = ownerOf(wallet)
        fund(wallet, 10_000)
        val due = authorized(wallet, merchant(), 1_000, expiresIn = 60)
        authorized(wallet, merchant(), 2_000, expiresIn = 3_600)

        assertEquals(0, expiryJob.runOnce(Instant.parse("2026-03-02T10:00:59Z")))
        assertEquals(1, expiryJob.runOnce(Instant.parse("2026-03-02T10:01:00Z")))
        assertEquals(0, expiryJob.runOnce(Instant.parse("2026-03-02T10:05:00Z")))

        assertEquals("expired", json(get("/v1/holds/$due", serviceKey)).path("status").asText())
        assertEquals(2_000, balance(wallet).heldMinor)
        assertEquals(2_000, limits.usage(owner, Currency.USD, day1))
        assertEquals(1, outboxCount("hold.expired"))
        assertEquals("hold_not_active", errorCode(release(due)))
    }

    @Test
    fun `release on a later day gives the limit back to the authorisation day`() {
        val wallet = wallet()
        val owner = ownerOf(wallet)
        fund(wallet, 10_000)
        val hold = authorized(wallet, merchant(), 3_000)
        assertEquals(3_000, limits.usage(owner, Currency.USD, day1))

        at("2026-03-04T09:00:00Z")
        transfer(wallet, wallet(), 500)
        assertEquals(200, release(hold).response.status)

        assertEquals(0, limits.usage(owner, Currency.USD, day1))
        assertEquals(500, limits.usage(owner, Currency.USD, LocalDate.parse("2026-03-04")))
    }

    @Test
    fun `holds count toward the limit and the captured part stays counted`() {
        val wallet = wallet()
        val owner = ownerOf(wallet)
        fund(wallet, 100_000)
        limits.setLimit(operatorKey.caller, owner, Currency.USD, 5_000)
        val hold = authorized(wallet, merchant(), 5_000)

        assertEquals("daily_limit_exceeded", errorCode(transfer(wallet, wallet(), 1)))
        capture(hold, 3_000)
        assertEquals(3_000, limits.usage(owner, Currency.USD, day1))
        assertEquals("daily_limit_exceeded", errorCode(transfer(wallet, wallet(), 2_001)))
        assertEquals(201, transfer(wallet, wallet(), 2_000).response.status)
    }

    @Test
    fun `a frozen wallet keeps its existing hold capturable but takes no new hold`() {
        val wallet = wallet()
        val shop = merchant()
        fund(wallet, 10_000)
        val hold = authorized(wallet, shop, 4_000)
        accounts.updateStatus(wallet, AccountStatus.FROZEN)

        assertEquals("account_frozen", errorCode(authorize(wallet, shop, 100)))
        assertEquals(200, capture(hold, 4_000).response.status)
        assertEquals(6_000, balance(wallet).postedMinor)
    }

    @Test
    fun `capture into a closed merchant account is refused`() {
        val wallet = wallet()
        val shop = merchant()
        fund(wallet, 10_000)
        val hold = authorized(wallet, shop, 4_000)
        accounts.updateStatus(shop, AccountStatus.CLOSED)
        assertEquals("account_closed", errorCode(capture(hold, 1_000)))
        assertEquals("active", json(get("/v1/holds/$hold", serviceKey)).path("status").asText())
    }

    @Test
    fun `merchants act on holds in their favour only`() {
        val owner = UUID.randomUUID()
        val shop = merchant(owner)
        val wallet = wallet()
        fund(wallet, 10_000)
        val mine = authorized(wallet, shop, 1_000)
        val theirs = authorized(wallet, merchant(), 1_000)
        val key = newKey(Role.MERCHANT, owner)

        assertEquals(200, get("/v1/holds/$mine", key).response.status)
        assertEquals(404, get("/v1/holds/$theirs", key).response.status)
        assertEquals(404, capture(theirs, 100, key).response.status)
        assertEquals(200, capture(mine, 100, key).response.status)
        assertEquals(403, release(theirs, auditorKey).response.status)
        assertEquals(403, post("/v1/holds", key, mapOf("accountId" to wallet, "merchantAccountId" to shop, "amountMinor" to 1, "currency" to "USD")).response.status)
    }

    @Test
    fun `hold events carry the hold version as sequence`() {
        val wallet = wallet()
        fund(wallet, 10_000)
        val hold = authorized(wallet, merchant(), 1_000)
        release(hold)
        val sequences = jdbc.sql(
            "SELECT (payload ->> 'sequence')::bigint FROM outbox WHERE payload ->> 'aggregateType' = 'hold' ORDER BY id"
        ).query(Long::class.javaObjectType).list()
        assertEquals(listOf(1L, 2L), sequences)
        assertEquals(1, outboxCount("hold.authorized"))
        assertEquals(1, outboxCount("hold.released"))
    }
}
