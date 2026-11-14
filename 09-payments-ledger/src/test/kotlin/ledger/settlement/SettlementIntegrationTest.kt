package ledger.settlement

import ledger.domain.AccountStatus
import ledger.domain.Currency
import ledger.domain.SettlementOutcome
import ledger.domain.SystemRole
import ledger.jobs.SettlementTriggerJob
import ledger.support.IntegrationTest
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import kotlin.test.assertEquals

class SettlementIntegrationTest : IntegrationTest() {
    @Autowired
    private lateinit var settlements: SettlementService

    @Autowired
    private lateinit var trigger: SettlementTriggerJob

    private val day: LocalDate = LocalDate.parse("2026-03-02")
    private val afterCutoff: Instant = Instant.parse("2026-03-03T00:15:00Z")

    private fun run(): SettlementView = settlements.run(day, Currency.USD, clock.instant(), null)

    private fun outcomeOf(view: SettlementView, merchant: UUID): SettlementOutcome =
        view.items.single { it.merchantAccountId == merchant }.outcome

    private fun paymentsTo(merchant: UUID): Long =
        jdbc.sql("SELECT count(*) FROM postings p JOIN journal_entries e ON e.id = p.entry_id WHERE e.kind = 'settlement' AND p.account_id = :m")
            .param("m", merchant).query(Long::class.javaObjectType).single()

    @Test
    fun `settlement cannot run before the cutoff`() {
        at("2026-03-02T23:59:59.999Z")
        val early = post("/v1/settlements", operatorKey, mapOf("businessDate" to "2026-03-02", "currency" to "USD"))
        assertEquals(422, early.response.status)
        assertEquals("settlement_too_early", errorCode(early))

        at("2026-03-03T00:00:00Z")
        assertEquals(200, post("/v1/settlements", operatorKey, mapOf("businessDate" to "2026-03-02", "currency" to "USD")).response.status)
    }

    @Test
    fun `each merchant gets the outcome its state calls for`() {
        val paid = merchant()
        val small = merchant()
        val empty = merchant()
        val frozen = merchant()
        val disabled = merchant(payoutEnabled = false)
        fund(paid, 5_000)
        fund(small, 999)
        fund(frozen, 5_000)
        fund(disabled, 5_000)
        accounts.updateStatus(frozen, AccountStatus.FROZEN)
        clock.set(afterCutoff)

        val view = run()

        assertEquals(BatchStatus.COMPLETED, view.batch.status)
        assertEquals(SettlementOutcome.PAID, outcomeOf(view, paid))
        assertEquals(SettlementOutcome.SKIPPED_BELOW_MINIMUM, outcomeOf(view, small))
        assertEquals(SettlementOutcome.SKIPPED_ZERO, outcomeOf(view, empty))
        assertEquals(SettlementOutcome.SKIPPED_FROZEN, outcomeOf(view, frozen))
        assertEquals(SettlementOutcome.SKIPPED_DISABLED, outcomeOf(view, disabled))
        assertEquals(0, balance(paid).postedMinor)
        assertEquals(5_000, balance(systemAccount(SystemRole.PAYOUT_CLEARING)).postedMinor)

        val expectation = jdbc.sql("SELECT reference, kind, amount_minor FROM bank_expectations WHERE account_id = :m")
            .param("m", paid)
            .query { rs, _ -> Triple(rs.getString("reference"), rs.getString("kind"), rs.getLong("amount_minor")) }
            .single()
        assertEquals("STL-20260302-" + paid.toString().replace("-", "").take(12).uppercase(), expectation.first)
        assertEquals("payout", expectation.second)
        assertEquals(5_000L, expectation.third)

        assertEquals(1, outboxCount("settlement.batch_completed"))
        val completed = mapper.readTree(
            jdbc.sql("SELECT payload::text FROM outbox WHERE payload ->> 'type' = 'settlement.batch_completed'").query(String::class.java).single()
        )
        assertEquals(1, completed.path("data").path("paidCount").asLong())
        assertEquals(5_000, completed.path("data").path("paidTotalMinor").asLong())
        assertEquals("2026-03-02", completed.path("data").path("businessDate").asText())
    }

    @Test
    fun `running settlement twice pays each merchant once`() {
        val m = merchant()
        fund(m, 5_000)
        clock.set(afterCutoff)
        val first = run()
        fund(m, 3_000)
        val second = run()

        assertEquals(first.batch.id, second.batch.id)
        assertEquals(1, paymentsTo(m))
        assertEquals(3_000, balance(m).postedMinor)
        assertEquals(1, outboxCount("settlement.batch_completed"))
    }

    @Test
    fun `two runs started together pay each merchant once and complete`() {
        val merchants = (1..6).map { i -> merchant().also { fund(it, 1_000L + 1_000L * i) } }
        clock.set(afterCutoff)

        val views = simultaneously(2) { run() }

        merchants.forEach { assertEquals(1, paymentsTo(it)) }
        assertEquals(1, views.map { it.batch.id }.toSet().size)
        assertEquals(BatchStatus.COMPLETED, settlements.get(operatorKey.caller, views[0].batch.id).batch.status)
        assertEquals(1, outboxCount("settlement.batch_completed"))
        assertEquals(6, jdbc.sql("SELECT count(*) FROM settlement_items").query(Long::class.javaObjectType).single())
    }

    @Test
    fun `money arriving after the cutoff waits and a later reversal lowers the payout`() {
        val late = merchant()
        val reversed = merchant()
        fund(late, 5_000)
        val wallet = wallet()
        fund(wallet, 10_000)
        val big = post("/v1/transfers", serviceKey, mapOf("fromAccountId" to wallet, "toAccountId" to reversed, "amountMinor" to 3_000, "currency" to "USD"))
        post("/v1/transfers", serviceKey, mapOf("fromAccountId" to wallet, "toAccountId" to reversed, "amountMinor" to 2_000, "currency" to "USD"))

        at("2026-03-03T00:05:00Z")
        fund(late, 4_000)
        post("/v1/entries/${json(big).path("id").asText()}/reverse", operatorKey, mapOf("reason" to "chargeback"))
        clock.set(afterCutoff)

        val view = run()

        assertEquals(5_000, view.items.single { it.merchantAccountId == late }.amountMinor)
        assertEquals(4_000, balance(late).postedMinor)
        assertEquals(2_000, view.items.single { it.merchantAccountId == reversed }.amountMinor)
        assertEquals(0, balance(reversed).postedMinor)
    }

    @Test
    fun `a run that fails part way resumes without paying anyone twice`() {
        val merchants = (1..3).map { merchant().also { fund(it, 5_000) } }
        val blocked = merchants[1]
        jdbc.sql(
            """
            CREATE FUNCTION test_block_item() RETURNS trigger LANGUAGE plpgsql AS
            $$ BEGIN IF NEW.merchant_account_id = '$blocked' THEN RAISE EXCEPTION 'simulated crash'; END IF; RETURN NEW; END $$
            """.trimIndent()
        ).update()
        jdbc.sql("CREATE TRIGGER test_block_item BEFORE INSERT ON settlement_items FOR EACH ROW EXECUTE FUNCTION test_block_item()").update()
        clock.set(afterCutoff)
        val first = try {
            run()
        } finally {
            jdbc.sql("DROP TRIGGER test_block_item ON settlement_items").update()
            jdbc.sql("DROP FUNCTION test_block_item()").update()
        }
        assertEquals(BatchStatus.PROCESSING, first.batch.status)
        assertEquals(2, first.items.size)
        assertEquals(5_000, balance(blocked).postedMinor)

        val resumed = run()

        assertEquals(BatchStatus.COMPLETED, resumed.batch.status)
        merchants.forEach { assertEquals(1, paymentsTo(it)) }
    }

    @Test
    fun `the nightly trigger settles yesterday and resumes older unfinished batches`() {
        val m = merchant()
        fund(m, 5_000)
        val euro = merchant(currency = Currency.EUR)
        fund(euro, 5_000)
        jdbc.sql(
            """
            INSERT INTO settlement_batches (id, business_date, currency, status, cutoff_at, created_at)
            VALUES (gen_random_uuid(), '2026-03-01', 'USD', 'processing', '2026-03-02T00:00:00Z', now())
            """.trimIndent()
        ).update()

        val views = trigger.runOnce(afterCutoff)

        assertEquals(1 + Currency.entries.size, views.size)
        assertEquals(views.size, views.count { it.batch.status == BatchStatus.COMPLETED })
        assertEquals(0, balance(m).postedMinor)
        assertEquals(0, balance(euro).postedMinor)
    }

    @Test
    fun `settlement endpoints are for operators and replay with the same key`() {
        val m = merchant()
        fund(m, 5_000)
        clock.set(afterCutoff)
        val body = mapOf("businessDate" to "2026-03-02", "currency" to "USD")
        assertEquals(403, post("/v1/settlements", serviceKey, body).response.status)

        val first = post("/v1/settlements", operatorKey, body, "settle-0001")
        val again = post("/v1/settlements", operatorKey, body, "settle-0001")
        assertEquals(200, first.response.status)
        assertEquals(json(first), json(again))
        assertEquals("true", again.response.getHeader("Idempotent-Replay"))

        val id = json(first).path("batch").path("id").asText()
        assertEquals("completed", json(get("/v1/settlements/$id", auditorKey)).path("batch").path("status").asText())
        assertEquals(404, get("/v1/settlements/${UUID.randomUUID()}", auditorKey).response.status)
    }
}
