package ledger.api

import ledger.domain.Currency
import ledger.domain.Role
import ledger.support.IntegrationTest
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AccountApiIntegrationTest : IntegrationTest() {
    @Test
    fun `creates a wallet with a deposit reference and an empty balance`() {
        val owner = UUID.randomUUID()
        val result = post("/v1/accounts", serviceKey, mapOf("ownerId" to owner, "type" to "customer_wallet", "currency" to "EUR"))

        assertEquals(201, result.response.status)
        val body = json(result)
        assertTrue(Regex("DEP-[A-Z2-7]{10}").matches(body.path("depositReference").asText()))
        assertEquals("active", body.path("status").asText())
        assertEquals(owner.toString(), body.path("ownerId").asText())
        assertTrue(body.path("feeBps").isNull)

        val balance = json(get("/v1/accounts/${body.path("id").asText()}/balance", auditorKey))
        assertEquals(0, balance.path("postedMinor").asLong())
        assertEquals(0, balance.path("availableMinor").asLong())
        assertEquals("EUR", balance.path("currency").asText())
        assertEquals(0, balance.path("version").asLong())
    }

    @Test
    fun `merchant accounts default to no fee and payouts enabled`() {
        val result = post(
            "/v1/accounts",
            operatorKey,
            mapOf("ownerId" to UUID.randomUUID(), "type" to "merchant", "currency" to "USD")
        )
        assertEquals(201, result.response.status)
        assertEquals(0, json(result).path("feeBps").asInt())
        assertTrue(json(result).path("payoutEnabled").asBoolean())
    }

    @Test
    fun `a second account of the same type and currency for an owner is refused`() {
        val owner = UUID.randomUUID()
        val body = mapOf("ownerId" to owner, "type" to "customer_wallet", "currency" to "USD")
        assertEquals(201, post("/v1/accounts", serviceKey, body).response.status)
        val second = post("/v1/accounts", serviceKey, body)
        assertEquals(409, second.response.status)
        assertEquals("invalid_state", errorCode(second))
    }

    @Test
    fun `system accounts cannot be created`() {
        val result = post("/v1/accounts", operatorKey, mapOf("ownerId" to UUID.randomUUID(), "type" to "system", "currency" to "USD"))
        assertEquals(422, result.response.status)
        assertEquals("invalid_account_type", errorCode(result))
    }

    @Test
    fun `malformed bodies are validation failures`() {
        val owner = UUID.randomUUID().toString()
        val cases = listOf(
            """{"ownerId":"$owner","type":"customer_wallet","currency":"USD","extra":1}""",
            """{"ownerId":"$owner","type":"customer_wallet","currency":"XYZ"}""",
            """{"ownerId":"not-a-uuid","type":"customer_wallet","currency":"USD"}""",
            """{"type":"customer_wallet","currency":"USD"}""",
            """{"ownerId":"$owner","type":"merchant","currency":"USD","feeBps":1001}""",
            """{"ownerId":"$owner","type":"merchant","currency":"USD","feeBps":"25"}""",
            """{"ownerId":"$owner","type":"customer_wallet","currency":"USD","feeBps":25}""",
            """{"ownerId":"$owner","type":"customer_wallet""""
        )
        cases.forEach { body ->
            val result = post("/v1/accounts", serviceKey, body)
            assertEquals(400, result.response.status, body)
            assertEquals("validation_failed", errorCode(result), body)
            assertTrue(json(result).path("error").path("details").path("fields").isArray, body)
        }
    }

    @Test
    fun `requests without a valid key are unauthenticated`() {
        val missing = mvc.perform(MockMvcRequestBuilders.get("/v1/accounts")).andReturn()
        assertEquals(401, missing.response.status)
        assertEquals("unauthenticated", errorCode(missing))

        val wrong = mvc.perform(MockMvcRequestBuilders.get("/v1/accounts").header("Authorization", "Bearer nope")).andReturn()
        assertEquals(401, wrong.response.status)
    }

    @Test
    fun `revoked keys stop working`() {
        val key = newKey(Role.AUDITOR)
        assertEquals(200, get("/v1/accounts", key).response.status)
        assertEquals(204, delete("/v1/api-keys/${key.id}", operatorKey).response.status)
        assertEquals(401, get("/v1/accounts", key).response.status)
    }

    @Test
    fun `error envelope carries the inbound request id`() {
        val result = mvc.perform(
            MockMvcRequestBuilders.get("/v1/accounts/${UUID.randomUUID()}")
                .header("Authorization", "Bearer ${auditorKey.secret}")
                .header("X-Request-Id", "req-123")
        ).andReturn()
        assertEquals(404, result.response.status)
        assertEquals("req-123", json(result).path("error").path("requestId").asText())
        assertEquals("req-123", result.response.getHeader("X-Request-Id"))
    }

    @Test
    fun `merchant keys see their own accounts and nobody else's`() {
        val owner = UUID.randomUUID()
        val mine = merchant(owner)
        val theirs = wallet()
        val key = newKey(Role.MERCHANT, owner)

        assertEquals(200, get("/v1/accounts/$mine", key).response.status)
        val foreign = get("/v1/accounts/$theirs", key)
        assertEquals(404, foreign.response.status)
        assertEquals("not_found", errorCode(foreign))
        assertEquals(404, get("/v1/accounts/$theirs/balance", key).response.status)
        assertEquals(404, get("/v1/accounts/$theirs/postings", key).response.status)

        val listed = json(get("/v1/accounts", key)).path("items")
        assertEquals(listOf(mine.toString()), listed.map { it.path("id").asText() })
        assertEquals(0, json(get("/v1/accounts?ownerId=${ownerOf(theirs)}", key)).path("items").size())
    }

    @Test
    fun `an owner's balances are listed by currency`() {
        val owner = UUID.randomUUID()
        val usd = wallet(owner)
        val eur = wallet(owner, Currency.EUR)
        val shop = merchant(owner)
        fund(usd, 1_500)
        fund(eur, 700)
        fund(shop, 300)

        val body = json(get("/v1/owners/$owner/balances", serviceKey))
        assertEquals(owner.toString(), body.path("ownerId").asText())
        val balances = body.path("balances").associate { it.path("accountId").asText() to it.path("postedMinor").asLong() }
        assertEquals(mapOf(usd.toString() to 1_500L, eur.toString() to 700L, shop.toString() to 300L), balances)
        assertEquals("EUR", body.path("balances")[0].path("currency").asText())

        val own = json(get("/v1/owners/$owner/balances", newKey(Role.MERCHANT, owner)))
        assertEquals(3, own.path("balances").size())
    }

    @Test
    fun `merchant and auditor keys cannot create accounts`() {
        val body = mapOf("ownerId" to UUID.randomUUID(), "type" to "customer_wallet", "currency" to "USD")
        assertEquals(403, post("/v1/accounts", auditorKey, body).response.status)
        assertEquals(403, post("/v1/accounts", newKey(Role.MERCHANT, UUID.randomUUID()), body).response.status)
    }

    @Test
    fun `postings are listed in entry order with a cursor`() {
        val a = wallet()
        repeat(3) { fund(a, 100L * (it + 1)) }

        val first = json(get("/v1/accounts/$a/postings?limit=2", auditorKey))
        assertEquals(listOf(100L, 200L), first.path("items").map { it.path("amountMinor").asLong() })
        val cursor = first.path("nextCursor").asText()

        val second = json(get("/v1/accounts/$a/postings?limit=2&after=$cursor", auditorKey))
        assertEquals(listOf(300L), second.path("items").map { it.path("amountMinor").asLong() })
        assertTrue(second.path("nextCursor").isNull)

        assertEquals(400, get("/v1/accounts/$a/postings?limit=201", auditorKey).response.status)
        assertEquals(400, get("/v1/accounts/$a/postings?after=bogus", auditorKey).response.status)
    }

    @Test
    fun `entries are readable by operators and auditors only`() {
        val a = wallet(currency = Currency.GBP)
        val entry = fund(a, 250)
        val read = json(get("/v1/entries/${entry.id}", auditorKey))
        assertEquals("deposit", read.path("kind").asText())
        assertEquals(2, read.path("postings").size())
        assertNull(read.path("reversesEntryId").textValue())
        assertEquals(403, get("/v1/entries/${entry.id}", serviceKey).response.status)
    }
}
