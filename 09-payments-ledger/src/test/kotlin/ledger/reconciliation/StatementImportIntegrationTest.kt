package ledger.reconciliation

import ledger.support.IntegrationTest
import ledger.support.StatementFiles
import org.junit.jupiter.api.Test
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class StatementImportIntegrationTest : IntegrationTest() {
    private val first = StatementFiles.csv(
        "BANK-USD", "USD", "2026-03-01", "0.00", "150.00",
        listOf("B1,2026-03-01,100.00,dep-aaaa, first", "B2,2026-03-01,50.00,DEP-BBBB,second")
    )

    private fun count(table: String): Long = jdbc.sql("SELECT count(*) FROM $table").query(Long::class.javaObjectType).single()

    private fun lineStatuses(statementId: String): List<String> =
        json(get("/v1/statements/$statementId/lines", auditorKey)).path("items").map { it.path("status").asText() }

    @Test
    fun `imports a statement with all its lines pending`() {
        val result = upload("BANK-USD", first)

        assertEquals(201, result.response.status, result.response.contentAsString)
        val statement = json(result)
        assertEquals(2, statement.path("lineCount").asInt())
        assertEquals(15_000, statement.path("closingMinor").asLong())
        val id = statement.path("id").asText()
        val lines = json(get("/v1/statements/$id/lines", auditorKey)).path("items")
        assertEquals(listOf("pending", "pending"), lines.map { it.path("status").asText() })
        assertEquals("DEP-AAAA", lines[0].path("reference").asText())
        assertEquals(1, lines[0].path("lineNo").asInt())
        assertEquals("first", lines[0].path("description").asText())
        assertEquals(1, json(get("/v1/statements/$id/lines?status=pending&limit=1", auditorKey)).path("items").size())
    }

    @Test
    fun `the same file twice stores one statement`() {
        val created = upload("BANK-USD", first)
        val again = upload("BANK-USD", first)

        assertEquals(201, created.response.status)
        assertEquals(200, again.response.status)
        assertEquals(json(created).path("id"), json(again).path("id"))
        assertEquals(1, count("statements"))
        assertEquals(2, count("statement_lines"))
    }

    @Test
    fun `a file one byte different is a new statement whose known lines are duplicates`() {
        val stored = upload("BANK-USD", first)
        assertEquals(201, stored.response.status)
        val next = StatementFiles.csv(
            "BANK-USD", "USD", "2026-03-02", "150.00", "180.00",
            listOf("B2,2026-03-01,50.00,DEP-BBBB,second", "B3,2026-03-02,30.00,DEP-CCCC,third", "B3,2026-03-02,-50.00,X,repeat")
        )

        val result = upload("BANK-USD", next)

        assertEquals(201, result.response.status, result.response.contentAsString)
        assertEquals(listOf("duplicate", "pending", "duplicate"), lineStatuses(json(result).path("id").asText()))
    }

    @Test
    fun `unbalanced files and gaps store nothing`() {
        val unbalanced = StatementFiles.csv("BANK-USD", "USD", "2026-03-01", "0.00", "151.00", listOf("B1,2026-03-01,150.00,R,"))
        val rejected = upload("BANK-USD", unbalanced)
        assertEquals(422, rejected.response.status)
        assertEquals("statement_unbalanced", errorCode(rejected))

        assertEquals(201, upload("BANK-USD", first).response.status)
        val gap = StatementFiles.csv("BANK-USD", "USD", "2026-03-02", "149.00", "149.00", emptyList())
        assertEquals("statement_gap", errorCode(upload("BANK-USD", gap)))
        val sameDay = StatementFiles.csv("BANK-USD", "USD", "2026-03-01", "150.00", "150.00", emptyList())
        assertEquals("statement_gap", errorCode(upload("BANK-USD", sameDay)))
        val otherCurrency = StatementFiles.csv("BANK-USD", "EUR", "2026-03-02", "150.00", "150.00", emptyList())
        assertEquals("statement_invalid", errorCode(upload("BANK-USD", otherCurrency)))

        assertEquals(1, count("statements"))
        assertEquals(2, count("statement_lines"))
    }

    @Test
    fun `a wrong number of decimals rejects the whole file`() {
        val usd = StatementFiles.csv("BANK-USD", "USD", "2026-03-01", "0.00", "12.50", listOf("B1,2026-03-01,12.5,R,"))
        val usdResult = upload("BANK-USD", usd)
        assertEquals("statement_invalid", errorCode(usdResult))
        val reported = json(usdResult).path("error").path("details").path("lines")
        assertEquals(3, reported[0].path("lineNo").asInt())

        val jpy = StatementFiles.csv("BANK-JPY", "JPY", "2026-03-01", "0", "1200", listOf("B1,2026-03-01,1200.00,R,"))
        assertEquals("statement_invalid", errorCode(upload("BANK-JPY", jpy)))
        assertEquals(0, count("statements"))
    }

    @Test
    fun `the header code must match the query parameter`() {
        assertEquals("statement_invalid", errorCode(upload("BANK-EUR", first)))
        assertEquals(400, upload("bad.code", first).response.status)
    }

    @Test
    fun `uploads must be csv, small enough and from an operator`() {
        val json = mvc.perform(
            MockMvcRequestBuilders.post("/v1/statements?bankAccountCode=BANK-USD")
                .header("Authorization", "Bearer ${operatorKey.secret}")
                .header("Idempotency-Key", "upload-key-1")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{}")
        ).andReturn()
        assertEquals(415, json.response.status)

        val big = "x".repeat(5 * 1024 * 1024 + 1)
        val tooLarge = upload("BANK-USD", big)
        assertEquals(413, tooLarge.response.status)
        assertEquals("payload_too_large", errorCode(tooLarge))

        assertEquals(403, upload("BANK-USD", first, key = auditorKey).response.status)
    }

    @Test
    fun `a repeated upload key with different bytes is refused`() {
        assertEquals(201, upload("BANK-USD", first, idempotencyKey = "upload-key-2").response.status)
        val other = StatementFiles.csv("BANK-USD", "USD", "2026-03-02", "150.00", "150.00", emptyList())
        val reused = upload("BANK-USD", other, idempotencyKey = "upload-key-2")
        assertEquals("idempotency_key_reused", errorCode(reused))
        assertTrue(count("statements") == 1L)
    }
}
