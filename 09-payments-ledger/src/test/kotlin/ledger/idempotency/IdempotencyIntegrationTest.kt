package ledger.idempotency

import ledger.domain.Role
import ledger.jobs.IdempotencyPurgeJob
import ledger.support.IntegrationTest
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.time.Duration
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.assertNull

class IdempotencyIntegrationTest : IntegrationTest() {
    @Autowired
    private lateinit var purgeJob: IdempotencyPurgeJob

    private fun walletBody(owner: UUID = UUID.randomUUID()) =
        mapOf("ownerId" to owner, "type" to "customer_wallet", "currency" to "USD")

    private fun accountCount(): Long =
        jdbc.sql("SELECT count(*) FROM accounts WHERE type <> 'system'").query(Long::class.javaObjectType).single()

    @Test
    fun `same key and body twice returns the stored response`() {
        val body = walletBody()
        val first = post("/v1/accounts", serviceKey, body, "key-0000001")
        val second = post("/v1/accounts", serviceKey, body, "key-0000001")

        assertEquals(201, first.response.status)
        assertEquals(201, second.response.status)
        assertNull(first.response.getHeader("Idempotent-Replay"))
        assertEquals("true", second.response.getHeader("Idempotent-Replay"))
        assertEquals(json(first), json(second))
        assertEquals(1, accountCount())
    }

    @Test
    fun `same key and body sent at once creates one account and both callers see it`() {
        val body = walletBody()
        val results = simultaneously(6) { post("/v1/accounts", serviceKey, body, "key-parallel-1") }

        assertEquals(1, accountCount())
        assertEquals(setOf(201), results.map { it.response.status }.toSet())
        assertEquals(1, results.map { json(it) }.toSet().size)
        assertEquals(5, results.count { it.response.getHeader("Idempotent-Replay") == "true" })
    }

    @Test
    fun `same key with a different body is refused`() {
        assertEquals(201, post("/v1/accounts", serviceKey, walletBody(), "key-0000002").response.status)
        val reused = post("/v1/accounts", serviceKey, walletBody(), "key-0000002")
        assertEquals(422, reused.response.status)
        assertEquals("idempotency_key_reused", errorCode(reused))
        assertEquals(1, accountCount())
    }

    @Test
    fun `business errors are stored and returned again`() {
        val body = walletBody()
        assertEquals(201, post("/v1/accounts", serviceKey, body).response.status)

        val conflict = post("/v1/accounts", serviceKey, body, "key-0000003")
        assertEquals(409, conflict.response.status)
        val again = post("/v1/accounts", serviceKey, body, "key-0000003")
        assertEquals(409, again.response.status)
        assertEquals("true", again.response.getHeader("Idempotent-Replay"))
        assertEquals(json(conflict), json(again))
    }

    @Test
    fun `forbidden responses are stored too`() {
        val first = post("/v1/accounts", auditorKey, walletBody(), "key-0000004")
        val second = post("/v1/accounts", auditorKey, walletBody(), "key-0000004")
        assertEquals(403, first.response.status)
        assertEquals(422, second.response.status)
        assertEquals("idempotency_key_reused", errorCode(second))
    }

    @Test
    fun `unexpected failures leave no key behind and the retry runs`() {
        jdbc.sql(
            """
            CREATE FUNCTION test_reject_accounts() RETURNS trigger LANGUAGE plpgsql AS
            $$ BEGIN RAISE EXCEPTION 'simulated outage'; END $$
            """.trimIndent()
        ).update()
        jdbc.sql(
            "CREATE TRIGGER test_reject_accounts BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION test_reject_accounts()"
        ).update()
        val body = walletBody()
        try {
            val failed = post("/v1/accounts", serviceKey, body, "key-0000005")
            assertEquals(500, failed.response.status)
            assertEquals("internal_error", errorCode(failed))
            assertEquals(
                0,
                jdbc.sql("SELECT count(*) FROM idempotency_keys").query(Long::class.javaObjectType).single()
            )
        } finally {
            jdbc.sql("DROP TRIGGER test_reject_accounts ON accounts").update()
            jdbc.sql("DROP FUNCTION test_reject_accounts()").update()
        }

        val retried = post("/v1/accounts", serviceKey, body, "key-0000005")
        assertEquals(201, retried.response.status)
        assertNull(retried.response.getHeader("Idempotent-Replay"))
    }

    @Test
    fun `keys are scoped to the api key that sent them`() {
        val otherService = newKey(Role.SERVICE)
        val first = post("/v1/accounts", serviceKey, walletBody(), "shared-key-1")
        val second = post("/v1/accounts", otherService, walletBody(), "shared-key-1")
        assertEquals(201, first.response.status)
        assertEquals(201, second.response.status)
        assertEquals(2, accountCount())
    }

    @Test
    fun `posts need a well formed idempotency key`() {
        listOf(null, "short", "has space inside", "x".repeat(129), "naïve-key-123").forEach { key ->
            val result = post("/v1/accounts", serviceKey, walletBody(), key)
            assertEquals(400, result.response.status, key)
            assertEquals("idempotency_key_required", errorCode(result), key)
        }
        assertEquals(0, accountCount())
    }

    @Test
    fun `an invalid body does not use up the key`() {
        val invalid = post("/v1/accounts", serviceKey, mapOf("ownerId" to UUID.randomUUID(), "type" to "customer_wallet"), "key-0000006")
        assertEquals(400, invalid.response.status)
        assertEquals(201, post("/v1/accounts", serviceKey, walletBody(), "key-0000006").response.status)
    }

    @Test
    fun `a created api key secret is returned once and never stored`() {
        val body = mapOf("name" to "reporting", "role" to "auditor")
        val first = post("/v1/api-keys", operatorKey, body, "key-api-0001")
        assertEquals(201, first.response.status)
        val secret = json(first).path("key").asText()
        assertTrue(secret.startsWith("lk_"))

        val stored = jdbc.sql("SELECT response_body::text FROM idempotency_keys WHERE key = 'key-api-0001'")
            .query(String::class.java).single()
        assertFalse(stored.contains(secret))
        assertFalse(mapper.readTree(stored).has("key"))

        val replay = post("/v1/api-keys", operatorKey, body, "key-api-0001")
        assertEquals(201, replay.response.status)
        assertEquals("true", replay.response.getHeader("Idempotent-Replay"))
        assertFalse(json(replay).has("key"))
        assertEquals(json(first).path("id"), json(replay).path("id"))
    }

    @Test
    fun `purge also removes keys left in progress past the retention`() {
        jdbc.sql(
            """
            INSERT INTO idempotency_keys (api_key_id, key, fingerprint, state, created_at)
            VALUES (:k, 'stuck-key-001', 'f', 'in_progress', '2026-02-01T00:00:00Z')
            """.trimIndent()
        ).param("k", operatorKey.id).update()
        assertEquals(1, purgeJob.runOnce(clock.instant()))
    }

    @Test
    fun `purge removes completed keys older than seven days`() {
        post("/v1/accounts", serviceKey, walletBody(), "key-old-0001")
        clock.advance(Duration.ofDays(8))
        post("/v1/accounts", serviceKey, walletBody(), "key-new-0001")

        val purged = purgeJob.runOnce(clock.instant())

        assertEquals(1, purged)
        assertEquals(
            listOf("key-new-0001"),
            jdbc.sql("SELECT key FROM idempotency_keys").query(String::class.java).list()
        )
    }
}
