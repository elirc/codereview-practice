package ledger.ledger

import ledger.domain.SystemRole
import ledger.support.IntegrationTest
import org.junit.jupiter.api.Test
import java.util.UUID
import kotlin.test.assertEquals

class AccountLifecycleIntegrationTest : IntegrationTest() {
    private fun action(account: UUID, name: String, key: String = UUID.randomUUID().toString()) =
        post("/v1/accounts/$account/$name", operatorKey, null, key)

    @Test
    fun `freeze and unfreeze move between active and frozen`() {
        val a = wallet()
        val frozen = action(a, "freeze")
        assertEquals(200, frozen.response.status)
        assertEquals("frozen", json(frozen).path("status").asText())
        assertEquals("invalid_state", errorCode(action(a, "freeze")))
        assertEquals("active", json(action(a, "unfreeze")).path("status").asText())
        assertEquals("invalid_state", errorCode(action(a, "unfreeze")))
    }

    @Test
    fun `status changes bump the balance version and are published`() {
        val a = wallet()
        fund(a, 100)
        action(a, "freeze")
        assertEquals(2, balance(a).version)
        val payload = mapper.readTree(
            jdbc.sql("SELECT payload::text FROM outbox WHERE payload ->> 'type' = 'account.status_changed'")
                .query(String::class.java).single()
        )
        assertEquals(2, payload.path("sequence").asLong())
        assertEquals("frozen", payload.path("data").path("status").asText())
        assertEquals("active", payload.path("data").path("previousStatus").asText())
    }

    @Test
    fun `closing needs a zero balance, nothing held and no open expectation`() {
        val withMoney = wallet()
        fund(withMoney, 100)
        assertEquals("account_not_empty", errorCode(action(withMoney, "close")))

        val withHold = wallet()
        fund(withHold, 100)
        val hold = post(
            "/v1/holds",
            serviceKey,
            mapOf("accountId" to withHold, "merchantAccountId" to merchant(), "amountMinor" to 100, "currency" to "USD")
        )
        assertEquals(201, hold.response.status)
        assertEquals(100, balance(withHold).heldMinor)
        assertEquals("account_not_empty", errorCode(action(withHold, "close")))

        val withExpectation = wallet()
        fund(withExpectation, 100)
        post("/v1/withdrawals", serviceKey, mapOf("accountId" to withExpectation, "amountMinor" to 100, "currency" to "USD"))
        assertEquals(0, balance(withExpectation).postedMinor)
        assertEquals("account_not_empty", errorCode(action(withExpectation, "close")))

        val empty = wallet()
        assertEquals("closed", json(action(empty, "close")).path("status").asText())
    }

    @Test
    fun `closed is terminal and accepts nothing`() {
        val a = wallet()
        val b = wallet()
        fund(b, 100)
        action(a, "close")

        assertEquals("invalid_state", errorCode(action(a, "unfreeze")))
        assertEquals("invalid_state", errorCode(action(a, "freeze")))
        assertEquals("invalid_state", errorCode(action(a, "close")))
        val credit = post("/v1/transfers", serviceKey, mapOf("fromAccountId" to b, "toAccountId" to a, "amountMinor" to 10, "currency" to "USD"))
        assertEquals("account_closed", errorCode(credit))
    }

    @Test
    fun `system accounts and non operators cannot change status`() {
        assertEquals("invalid_account_type", errorCode(action(systemAccount(SystemRole.SUSPENSE), "freeze")))
        val a = wallet()
        assertEquals(403, post("/v1/accounts/$a/freeze", serviceKey).response.status)
        assertEquals(404, action(UUID.randomUUID(), "freeze").response.status)
    }

    @Test
    fun `one idempotency key cannot be reused on another account's path`() {
        val a = wallet()
        val b = wallet()
        assertEquals(200, action(a, "freeze", "freeze-key-1").response.status)
        val reused = action(b, "freeze", "freeze-key-1")
        assertEquals(422, reused.response.status)
        assertEquals("idempotency_key_reused", errorCode(reused))
        val replay = action(a, "freeze", "freeze-key-1")
        assertEquals(200, replay.response.status)
        assertEquals("true", replay.response.getHeader("Idempotent-Replay"))
    }
}
