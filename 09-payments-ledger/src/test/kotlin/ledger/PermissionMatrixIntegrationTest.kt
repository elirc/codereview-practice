package ledger

import ledger.domain.Role
import ledger.support.IntegrationTest
import ledger.support.StatementFiles
import ledger.support.TestKey
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.MvcResult
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class PermissionMatrixIntegrationTest : IntegrationTest() {
    private class Endpoint(val name: String, val allowed: Set<Role>, val call: (TestKey) -> MvcResult)

    private fun endpoints(merchantAccount: UUID, wallet: UUID, hold: String): List<Endpoint> {
        val randomId = UUID.randomUUID()
        val accountBody = mapOf("ownerId" to UUID.randomUUID(), "type" to "customer_wallet", "currency" to "USD")
        val transferBody = mapOf("fromAccountId" to wallet, "toAccountId" to randomId, "amountMinor" to 1, "currency" to "USD")
        val statement = StatementFiles.csv("BANK-USD", "USD", "2026-03-01", "0.00", "0.00", emptyList())
        val all = Role.entries.toSet()
        return listOf(
            Endpoint("create account", setOf(Role.SERVICE, Role.OPERATOR)) { post("/v1/accounts", it, accountBody) },
            Endpoint("read balance", all) { get("/v1/accounts/$merchantAccount/balance", it) },
            Endpoint("transfer", setOf(Role.SERVICE)) { post("/v1/transfers", it, transferBody) },
            Endpoint("withdraw", setOf(Role.SERVICE)) {
                post("/v1/withdrawals", it, mapOf("accountId" to wallet, "amountMinor" to 1, "currency" to "USD"))
            },
            Endpoint("authorise hold", setOf(Role.SERVICE)) {
                post("/v1/holds", it, mapOf("accountId" to wallet, "merchantAccountId" to merchantAccount, "amountMinor" to 1, "currency" to "USD"))
            },
            Endpoint("read hold", all) { get("/v1/holds/$hold", it) },
            Endpoint("capture hold", setOf(Role.SERVICE, Role.MERCHANT, Role.OPERATOR)) {
                post("/v1/holds/$randomId/capture", it, mapOf("amountMinor" to 1))
            },
            Endpoint("release hold", setOf(Role.SERVICE, Role.MERCHANT, Role.OPERATOR)) { post("/v1/holds/$randomId/release", it) },
            Endpoint("fx quote", setOf(Role.SERVICE)) {
                post("/v1/fx/quotes", it, mapOf("ownerId" to randomId, "sellCurrency" to "USD", "buyCurrency" to "EUR", "sellAmountMinor" to 100))
            },
            Endpoint("fx transfer", setOf(Role.SERVICE)) {
                post("/v1/fx/transfers", it, mapOf("quoteId" to randomId, "fromAccountId" to wallet, "toAccountId" to randomId))
            },
            Endpoint("publish rate", setOf(Role.OPERATOR)) {
                post("/v1/fx/rates", it, mapOf("sellCurrency" to "USD", "buyCurrency" to "GBP", "midRate" to "0.79000000", "spreadBps" to 10))
            },
            Endpoint("reverse entry", setOf(Role.OPERATOR)) { post("/v1/entries/$randomId/reverse", it, mapOf("reason" to "test")) },
            Endpoint("freeze account", setOf(Role.OPERATOR)) { post("/v1/accounts/$randomId/freeze", it) },
            Endpoint("set limit", setOf(Role.OPERATOR)) { put("/v1/owners/$randomId/limits/USD", it, mapOf("dailyOutMinor" to 10)) },
            Endpoint("run settlement", setOf(Role.OPERATOR)) {
                post("/v1/settlements", it, mapOf("businessDate" to "2026-03-01", "currency" to "USD"))
            },
            Endpoint("import statement", setOf(Role.OPERATOR)) { upload("BANK-USD", statement, key = it) },
            Endpoint("resolve line", setOf(Role.OPERATOR)) {
                post("/v1/statement-lines/$randomId/resolve", it, mapOf("action" to "dismiss", "note" to "n"))
            },
            Endpoint("read entry", setOf(Role.OPERATOR, Role.AUDITOR)) { get("/v1/entries/$randomId", it) },
            Endpoint("read settlement", setOf(Role.OPERATOR, Role.AUDITOR)) { get("/v1/settlements/$randomId", it) },
            Endpoint("read statement", setOf(Role.OPERATOR, Role.AUDITOR)) { get("/v1/statements/$randomId", it) },
            Endpoint("report", setOf(Role.OPERATOR, Role.AUDITOR)) { get("/v1/reconciliation/report?from=2026-03-01&to=2026-03-02", it) },
            Endpoint("trial balance", setOf(Role.OPERATOR, Role.AUDITOR)) { get("/v1/trial-balance", it) },
            Endpoint("create api key", setOf(Role.OPERATOR)) { post("/v1/api-keys", it, mapOf("name" to "k", "role" to "auditor")) },
            Endpoint("revoke api key", setOf(Role.OPERATOR)) { delete("/v1/api-keys/$randomId", it) },
            Endpoint("outbox stats", setOf(Role.OPERATOR)) { get("/v1/outbox/stats", it) }
        )
    }

    @Test
    fun `each role reaches exactly the endpoints the permission table grants`() {
        val owner = UUID.randomUUID()
        val merchantAccount = merchant(owner)
        val wallet = wallet()
        fund(wallet, 10_000)
        val hold = json(
            post("/v1/holds", serviceKey, mapOf("accountId" to wallet, "merchantAccountId" to merchantAccount, "amountMinor" to 100, "currency" to "USD"))
        ).path("id").asText()
        at("2026-03-03T01:00:00Z")
        val keys = mapOf(
            Role.SERVICE to serviceKey,
            Role.MERCHANT to newKey(Role.MERCHANT, owner),
            Role.OPERATOR to operatorKey,
            Role.AUDITOR to auditorKey
        )

        endpoints(merchantAccount, wallet, hold).forEach { endpoint ->
            keys.forEach { (role, key) ->
                val result = endpoint.call(key)
                val label = "${endpoint.name} as ${role.wire}: ${result.response.contentAsString}"
                assertNotEquals(401, result.response.status, label)
                if (role in endpoint.allowed) {
                    assertNotEquals(403, result.response.status, label)
                } else {
                    assertEquals(403, result.response.status, label)
                    assertEquals("forbidden", errorCode(result), label)
                }
            }
        }
    }

    @Test
    fun `merchant keys get not found for accounts and holds of other owners`() {
        val owner = UUID.randomUUID()
        val mine = merchant(owner)
        val other = merchant()
        val wallet = wallet()
        fund(wallet, 1_000)
        val foreignHold = json(
            post("/v1/holds", serviceKey, mapOf("accountId" to wallet, "merchantAccountId" to other, "amountMinor" to 100, "currency" to "USD"))
        ).path("id").asText()
        val key = newKey(Role.MERCHANT, owner)

        assertEquals(200, get("/v1/accounts/$mine", key).response.status)
        listOf(
            get("/v1/accounts/$other", key),
            get("/v1/accounts/$wallet/balance", key),
            get("/v1/accounts/$other/postings", key),
            get("/v1/holds/$foreignHold", key),
            post("/v1/holds/$foreignHold/capture", key, mapOf("amountMinor" to 50)),
            post("/v1/holds/$foreignHold/release", key)
        ).forEach { result ->
            assertEquals(404, result.response.status)
            assertEquals("not_found", errorCode(result))
        }
        assertEquals("active", json(get("/v1/holds/$foreignHold", serviceKey)).path("status").asText())
    }
}
