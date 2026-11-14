package ledger.domain

import ledger.support.StatementFiles
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.LocalDate
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class StatementParserTest {
    private fun parse(csv: String, code: String = "BANK-USD"): ParsedStatement = StatementParser.parse(csv.toByteArray(), code)

    @Suppress("UNCHECKED_CAST")
    private fun problems(e: BusinessRuleException): List<LineProblem> = e.details["lines"] as List<LineProblem>

    @Test
    fun `parses header, lines and normalises references`() {
        val parsed = parse(
            StatementFiles.csv(
                "BANK-USD", "USD", "2026-03-02", "100.00", "87.50",
                listOf("L1,2026-03-02,-12.50,  wdr-abc ,\"Payout, batch 7\"")
            )
        )
        assertEquals(StatementHeader("BANK-USD", Currency.USD, LocalDate.parse("2026-03-02"), 10_000, 8_750), parsed.header)
        val line = parsed.lines.single()
        assertEquals(1, line.lineNo)
        assertEquals(-1_250, line.amountMinor)
        assertEquals("WDR-ABC", line.reference)
        assertEquals("Payout, batch 7", line.description)
    }

    @Test
    fun `parses yen and dinar amounts`() {
        val yen = parse(StatementFiles.csv("BANK-JPY", "JPY", "2026-03-02", "0", "1200", listOf("L1,2026-03-02,1200,DEP-X,")), "BANK-JPY")
        assertEquals(1_200, yen.lines.single().amountMinor)
        val dinar = parse(StatementFiles.csv("BANK-KWD", "KWD", "2026-03-02", "1.000", "1.125", listOf("L1,2026-03-02,0.125,X,")), "BANK-KWD")
        assertEquals(125, dinar.lines.single().amountMinor)
    }

    @Test
    fun `an empty statement is valid`() {
        assertEquals(0, parse(StatementFiles.csv("BANK-USD", "USD", "2026-03-02", "5.00", "5.00", emptyList())).lines.size)
    }

    @Test
    fun `collects every bad line`() {
        val csv = StatementFiles.csv(
            "BANK-USD", "USD", "2026-03-02", "0.00", "0.00",
            listOf(
                "L1,2026-03-02,12.5,A,",
                "L2,2026-03-02,1.00,B,",
                "L3,02/03/2026,1.00,C,",
                ",2026-03-02,1.00,D,",
                "L5,2026-03-02,0.00,E,",
                "L6,2026-03-02,1.00"
            )
        )
        val error = assertThrows<BusinessRuleException> { parse(csv) }
        assertEquals("statement_invalid", error.code)
        assertEquals(listOf(3L, 5L, 6L, 7L, 8L), problems(error).map { it.lineNo })
    }

    @Test
    fun `reports at most fifty problems`() {
        val lines = (1..80).map { "L$it,2026-03-02,1.0,R," }
        val error = assertThrows<BusinessRuleException> { parse(StatementFiles.csv("BANK-USD", "USD", "2026-03-02", "0.00", "0.00", lines)) }
        assertEquals(50, problems(error).size)
        assertEquals(80, error.details["problemCount"])
    }

    @Test
    fun `header and trailer are checked`() {
        val wrongCode = assertThrows<BusinessRuleException> {
            parse(StatementFiles.csv("OTHER", "USD", "2026-03-02", "0.00", "0.00", emptyList()))
        }
        assertTrue(problems(wrongCode).single().message.contains("does not match"))

        val wrongCount = assertThrows<BusinessRuleException> {
            parse(StatementFiles.csv("BANK-USD", "USD", "2026-03-02", "0.00", "1.00", listOf("L1,2026-03-02,1.00,R,"), trailerCount = 2))
        }
        assertEquals("statement_invalid", wrongCount.code)

        val noHeader = assertThrows<BusinessRuleException> { parse("bank_line_id,booking_date,amount,reference,description\n#TRAILER,0\n") }
        assertEquals("statement_invalid", noHeader.code)

        val badCurrency = assertThrows<BusinessRuleException> {
            parse(StatementFiles.csv("BANK-USD", "CHF", "2026-03-02", "0.00", "0.00", emptyList()))
        }
        assertEquals("statement_invalid", badCurrency.code)
    }

    @Test
    fun `wrong decimals in the header reject the file`() {
        val error = assertThrows<BusinessRuleException> {
            parse(StatementFiles.csv("BANK-JPY", "JPY", "2026-03-02", "1200.00", "1200.00", emptyList()), "BANK-JPY")
        }
        assertEquals(2, problems(error).size)
    }

    @Test
    fun `opening plus lines must equal closing`() {
        val error = assertThrows<BusinessRuleException> {
            parse(StatementFiles.csv("BANK-USD", "USD", "2026-03-02", "10.00", "15.00", listOf("L1,2026-03-02,4.99,R,")))
        }
        assertEquals("statement_unbalanced", error.code)
        assertEquals(1_499L, error.details["expectedClosingMinor"])
    }

    @Test
    fun `invalid utf8 and broken csv are refused`() {
        val bytes = StatementFiles.csv("BANK-USD", "USD", "2026-03-02", "0.00", "0.00", emptyList()).toByteArray() + byteArrayOf(0xC3.toByte())
        assertEquals("statement_invalid", assertThrows<BusinessRuleException> { StatementParser.parse(bytes, "BANK-USD") }.code)
        val broken = StatementFiles.csv("BANK-USD", "USD", "2026-03-02", "0.00", "1.00", listOf("L1,2026-03-02,1.00,\"unterminated,"))
        assertEquals("statement_invalid", assertThrows<BusinessRuleException> { parse(broken) }.code)
    }

    @Test
    fun `more than fifty thousand lines is refused`() {
        val lines = (1..50_001).map { "L$it,2026-03-02,0.01,R," }
        val error = assertThrows<BusinessRuleException> {
            parse(StatementFiles.csv("BANK-USD", "USD", "2026-03-02", "0.00", "500.01", lines))
        }
        assertTrue(problems(error).any { it.message.contains("at most") })
    }
}
