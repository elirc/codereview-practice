package ledger.reconciliation

import ledger.domain.AccountStatus
import ledger.domain.Currency
import ledger.domain.MinorUnits
import ledger.domain.SystemRole
import ledger.jobs.ReconcileJob
import ledger.support.IntegrationTest
import ledger.support.StatementFiles
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.time.LocalDate
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ReconciliationIntegrationTest : IntegrationTest() {
    @Autowired
    private lateinit var job: ReconcileJob

    private var closing = 0L
    private var statementDay: LocalDate = LocalDate.parse("2026-03-01")

    private data class Line(val bankLineId: String, val amountMinor: Long, val reference: String)

    /** Imports the next daily statement for BANK-USD with [lines]. */
    private fun importStatement(vararg lines: Line, code: String = "BANK-USD", currency: Currency = Currency.USD) {
        val opening = closing
        closing = lines.fold(opening) { acc, line -> acc + line.amountMinor }
        statementDay = statementDay.plusDays(1)
        val csv = StatementFiles.csv(
            code,
            currency.name,
            statementDay.toString(),
            MinorUnits.format(opening, currency),
            MinorUnits.format(closing, currency),
            lines.map { "${it.bankLineId},$statementDay,${MinorUnits.format(it.amountMinor, currency)},${it.reference},test" }
        )
        val result = upload(code, csv)
        assertEquals(201, result.response.status, result.response.contentAsString)
    }

    private fun line(bankLineId: String): StatementLine =
        jdbc.sql("SELECT * FROM statement_lines WHERE bank_line_id = :id AND status <> 'duplicate'")
            .param("id", bankLineId)
            .query(StatementQueries.LINE)
            .single()

    private fun reconcile() = job.runOnce(clock.instant())

    private fun depositReference(account: UUID): String = accounts.get(account).depositReference!!

    private fun withdrawalReference(account: UUID, amount: Long): String {
        val result = post("/v1/withdrawals", serviceKey, mapOf("accountId" to account, "amountMinor" to amount, "currency" to "USD"))
        assertEquals(201, result.response.status, result.response.contentAsString)
        return jdbc.sql("SELECT reference FROM bank_expectations WHERE source_entry_id = :id")
            .param("id", UUID.fromString(json(result).path("id").asText()))
            .query(String::class.java)
            .single()
    }

    private fun expectationStatus(reference: String): String =
        jdbc.sql("SELECT status FROM bank_expectations WHERE reference = :r").param("r", reference).query(String::class.java).single()

    @Test
    fun `a credit with a deposit reference funds the account once whatever its case`() {
        val wallet = wallet()
        importStatement(Line("C1", 2_500, "  ${depositReference(wallet).lowercase()} "))

        assertEquals(1, reconcile())
        assertEquals(0, reconcile())

        assertEquals(LineStatus.MATCHED, line("C1").status)
        assertEquals(2_500, balance(wallet).postedMinor)
        assertEquals(-2_500, balance(systemAccount(SystemRole.BANK_CASH)).postedMinor)
    }

    @Test
    fun `a deposit for a closed account goes to suspense and stays unmatched`() {
        val wallet = wallet()
        accounts.updateStatus(wallet, AccountStatus.CLOSED)
        importStatement(Line("C1", 700, depositReference(wallet)))

        reconcile()

        val stored = line("C1")
        assertEquals(LineStatus.UNMATCHED, stored.status)
        assertTrue(stored.note!!.contains("closed"))
        assertEquals(700, balance(systemAccount(SystemRole.SUSPENSE)).postedMinor)
        assertEquals(0, balance(wallet).postedMinor)
    }

    @Test
    fun `a credit with an unknown reference posts nothing`() {
        importStatement(Line("C1", 900, "SOMETHING-ELSE"))
        reconcile()
        assertEquals(LineStatus.UNMATCHED, line("C1").status)
        assertEquals(0, entryCount())
    }

    @Test
    fun `a statement in another currency does not match`() {
        val wallet = wallet()
        importStatement(Line("C1", 900, depositReference(wallet)), code = "BANK-EUR", currency = Currency.EUR)
        reconcile()
        assertEquals(LineStatus.UNMATCHED, line("C1").status)
        assertEquals(0, balance(wallet).postedMinor)
    }

    @Test
    fun `a debit matching an open withdrawal clears it and a repeat of the reference is unmatched`() {
        val wallet = wallet()
        fund(wallet, 5_000)
        val reference = withdrawalReference(wallet, 1_200)
        importStatement(Line("D1", -1_200, reference))
        importStatement(Line("D2", -1_200, reference))

        reconcile()

        assertEquals(LineStatus.MATCHED, line("D1").status)
        assertEquals(LineStatus.UNMATCHED, line("D2").status)
        assertEquals("matched", expectationStatus(reference))
        assertEquals(0, balance(systemAccount(SystemRole.PAYOUT_CLEARING)).postedMinor)
        assertEquals(-3_800, balance(systemAccount(SystemRole.BANK_CASH)).postedMinor)
        assertEquals(1, outboxCount("payout.matched"))
    }

    @Test
    fun `a debit with the right reference and another amount is reported and posts nothing`() {
        val wallet = wallet()
        fund(wallet, 5_000)
        val reference = withdrawalReference(wallet, 1_200)
        importStatement(Line("D1", -1_000, reference))
        val entries = entryCount()

        reconcile()

        assertEquals(LineStatus.AMOUNT_MISMATCH, line("D1").status)
        assertEquals(entries, entryCount())
        assertEquals("open", expectationStatus(reference))
        val event = mapper.readTree(
            jdbc.sql("SELECT payload::text FROM outbox WHERE payload ->> 'type' = 'reconciliation.discrepancy_found'")
                .query(String::class.java).single()
        )
        assertEquals(-1_000, event.path("data").path("lineAmountMinor").asLong())
        assertEquals(1_200, event.path("data").path("expectedAmountMinor").asLong())
        assertEquals(1, event.path("sequence").asLong())
    }

    @Test
    fun `a return of a matched payout comes back from bank cash and of an open payout from clearing`() {
        val wallet = wallet()
        fund(wallet, 10_000)
        val matched = withdrawalReference(wallet, 1_000)
        val open = withdrawalReference(wallet, 2_000)
        importStatement(Line("D1", -1_000, matched))
        reconcile()
        val bankCashBefore = balance(systemAccount(SystemRole.BANK_CASH)).postedMinor
        val clearingBefore = balance(systemAccount(SystemRole.PAYOUT_CLEARING)).postedMinor

        importStatement(Line("R1", 1_000, "RET-$matched"), Line("R2", 2_000, "ret-$open"))
        reconcile()

        assertEquals(LineStatus.MATCHED, line("R1").status)
        assertEquals(LineStatus.MATCHED, line("R2").status)
        assertEquals("returned", expectationStatus(matched))
        assertEquals("returned", expectationStatus(open))
        assertEquals(bankCashBefore - 1_000, balance(systemAccount(SystemRole.BANK_CASH)).postedMinor)
        assertEquals(clearingBefore - 2_000, balance(systemAccount(SystemRole.PAYOUT_CLEARING)).postedMinor)
        assertEquals(10_000, balance(wallet).postedMinor)
        assertEquals(2, outboxCount("payout.returned"))
    }

    @Test
    fun `two reconcile runs at once process each line once`() {
        val wallets = (1..20).map { wallet() }
        importStatement(*wallets.mapIndexed { i, w -> Line("C$i", 100L + i, depositReference(w)) }.toTypedArray())

        val processed = simultaneously(2) { reconcile() }

        assertEquals(20, processed.sum())
        wallets.forEachIndexed { i, w -> assertEquals(100L + i, balance(w).postedMinor) }
        assertEquals(20, jdbc.sql("SELECT count(*) FROM journal_entries WHERE kind = 'deposit'").query(Long::class.javaObjectType).single())
    }

    @Test
    fun `a line that keeps failing becomes unmatched after five attempts`() {
        val wallet = wallet()
        importStatement(Line("C1", 500, depositReference(wallet)))
        jdbc.sql(
            """
            CREATE FUNCTION test_fail_postings() RETURNS trigger LANGUAGE plpgsql AS
            $$ BEGIN RAISE EXCEPTION 'ledger unavailable'; END $$
            """.trimIndent()
        ).update()
        jdbc.sql("CREATE TRIGGER test_fail_postings BEFORE INSERT ON postings FOR EACH ROW EXECUTE FUNCTION test_fail_postings()").update()
        try {
            repeat(4) { reconcile() }
            assertEquals(LineStatus.PENDING, line("C1").status)
            assertEquals(4, line("C1").attempts)
            reconcile()
        } finally {
            jdbc.sql("DROP TRIGGER test_fail_postings ON postings").update()
            jdbc.sql("DROP FUNCTION test_fail_postings()").update()
        }
        val failed = line("C1")
        assertEquals(LineStatus.UNMATCHED, failed.status)
        assertTrue(failed.note!!.contains("ledger unavailable"))
        assertEquals(0, balance(wallet).postedMinor)
    }

    @Test
    fun `operators resolve unmatched lines by deposit, suspense or dismissal`() {
        val wallet = wallet()
        importStatement(Line("C1", 800, "UNKNOWN-1"), Line("D1", -300, "UNKNOWN-2"), Line("C2", 50, "UNKNOWN-3"))
        reconcile()

        val deposit = post("/v1/statement-lines/${line("C1").id}/resolve", operatorKey, mapOf("action" to "deposit_to_account", "accountId" to wallet))
        assertEquals(200, deposit.response.status, deposit.response.contentAsString)
        assertEquals("resolved", json(deposit).path("status").asText())
        assertEquals(800, balance(wallet).postedMinor)

        val suspense = post("/v1/statement-lines/${line("D1").id}/resolve", operatorKey, mapOf("action" to "to_suspense"))
        assertEquals(200, suspense.response.status)
        assertEquals(-300, balance(systemAccount(SystemRole.SUSPENSE)).postedMinor)

        assertEquals(400, post("/v1/statement-lines/${line("C2").id}/resolve", operatorKey, mapOf("action" to "dismiss")).response.status)
        val dismissed = post("/v1/statement-lines/${line("C2").id}/resolve", operatorKey, mapOf("action" to "dismiss", "note" to "bank fee refund"))
        assertEquals("bank fee refund", json(dismissed).path("note").asText())

        val twice = post("/v1/statement-lines/${line("C2").id}/resolve", operatorKey, mapOf("action" to "dismiss", "note" to "again"))
        assertEquals(409, twice.response.status)
        assertEquals("invalid_state", errorCode(twice))
    }

    @Test
    fun `deposit resolution needs a credit line and a matching account`() {
        val wallet = wallet()
        val euro = wallet(currency = Currency.EUR)
        importStatement(Line("D1", -300, "UNKNOWN-2"), Line("C1", 300, "UNKNOWN-1"))
        reconcile()

        assertEquals("invalid_state", errorCode(post("/v1/statement-lines/${line("D1").id}/resolve", operatorKey, mapOf("action" to "deposit_to_account", "accountId" to wallet))))
        assertEquals("currency_mismatch", errorCode(post("/v1/statement-lines/${line("C1").id}/resolve", operatorKey, mapOf("action" to "deposit_to_account", "accountId" to euro))))
        assertEquals(400, post("/v1/statement-lines/${line("C1").id}/resolve", operatorKey, mapOf("action" to "deposit_to_account")).response.status)
        assertEquals(403, post("/v1/statement-lines/${line("C1").id}/resolve", auditorKey, mapOf("action" to "dismiss", "note" to "x")).response.status)
    }

    @Test
    fun `money already in suspense is moved from suspense when deposited`() {
        val closed = wallet()
        accounts.updateStatus(closed, AccountStatus.CLOSED)
        val replacement = wallet()
        importStatement(Line("C1", 700, depositReference(closed)))
        reconcile()

        post("/v1/statement-lines/${line("C1").id}/resolve", operatorKey, mapOf("action" to "deposit_to_account", "accountId" to replacement))

        assertEquals(700, balance(replacement).postedMinor)
        assertEquals(0, balance(systemAccount(SystemRole.SUSPENSE)).postedMinor)
        assertEquals(-700, balance(systemAccount(SystemRole.BANK_CASH)).postedMinor)
    }

    @Test
    fun `the report lists open items and explains the bank difference`() {
        val wallet = wallet()
        fund(wallet, 10_000)
        withdrawalReference(wallet, 1_500)
        importStatement(Line("C1", 400, "UNKNOWN-1"), Line("C2", 600, depositReference(wallet)))
        reconcile()
        at("2026-03-06T10:00:00Z")

        val report = json(get("/v1/reconciliation/report?from=2026-03-01&to=2026-03-05", auditorKey))

        assertEquals(listOf("UNKNOWN-1"), report.path("unresolvedLines").map { it.path("reference").asText() })
        assertEquals(1, report.path("overdueExpectations").size())
        val position = report.path("bankAccounts")[0]
        assertEquals("BANK-USD", position.path("bankAccountCode").asText())
        assertEquals(1_000, position.path("statementClosingMinor").asLong())
        assertEquals(10_600, position.path("ledgerBankMinor").asLong())
        assertEquals(-9_600, position.path("differenceMinor").asLong())
        assertEquals(400, position.path("unresolvedLineTotalMinor").asLong())
        assertEquals(1_500, position.path("openExpectationTotalMinor").asLong())

        assertEquals(400, get("/v1/reconciliation/report?from=2026-03-05&to=2026-03-01", auditorKey).response.status)
        assertEquals(403, get("/v1/reconciliation/report?from=2026-03-01&to=2026-03-05", serviceKey).response.status)
    }
}
