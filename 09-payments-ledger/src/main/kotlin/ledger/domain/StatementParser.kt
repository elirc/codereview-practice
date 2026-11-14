package ledger.domain

import org.apache.commons.csv.CSVFormat
import org.apache.commons.csv.CSVParser
import org.apache.commons.csv.CSVRecord
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.time.LocalDate
import java.time.format.DateTimeParseException

data class StatementHeader(
    val bankAccountCode: String,
    val currency: Currency,
    val statementDate: LocalDate,
    val openingMinor: Long,
    val closingMinor: Long
)

/** One data line; [lineNo] counts data lines from 1. */
data class ParsedLine(
    val lineNo: Int,
    val bankLineId: String,
    val bookingDate: LocalDate,
    val amountMinor: Long,
    val reference: String,
    val description: String
)

data class ParsedStatement(val header: StatementHeader, val lines: List<ParsedLine>)

/** A problem found in the file; [lineNo] is the CSV record number, 1 being the header record. */
data class LineProblem(val lineNo: Long, val message: String)

/** Parses bank statement CSV files. */
object StatementParser {
    const val MAX_DATA_LINES = 50_000
    const val MAX_REPORTED_PROBLEMS = 50
    private const val MAX_BANK_LINE_ID = 100
    private const val MAX_REFERENCE = 200
    private const val MAX_DESCRIPTION = 500
    private val COLUMNS = listOf("bank_line_id", "booking_date", "amount", "reference", "description")

    /**
     * Parses a statement file and returns its header and data lines.
     * Throws `statement_invalid` listing the problems found, or `statement_unbalanced` when the amounts
     * do not lead from the opening to the closing balance.
     */
    fun parse(bytes: ByteArray, expectedBankAccountCode: String): ParsedStatement {
        val records = readRecords(bytes)
        if (records.size < 3) throw invalid(listOf(LineProblem(1, "the file needs a header, a column row and a trailer")))

        val problems = mutableListOf<LineProblem>()
        val header = parseHeader(records.first(), expectedBankAccountCode, problems)

        val columns = records[1]
        if (columns.toList().map { it.trim() } != COLUMNS) {
            problems += LineProblem(columns.recordNumber, "the column row must be ${COLUMNS.joinToString(",")}")
        }

        val trailer = records.last()
        val dataRecords = records.subList(2, records.size - 1)
        checkTrailer(trailer, dataRecords.size, problems)
        if (dataRecords.size > MAX_DATA_LINES) {
            problems += LineProblem(trailer.recordNumber, "a statement may have at most $MAX_DATA_LINES data lines")
        }

        val lines = mutableListOf<ParsedLine>()
        if (header != null) {
            dataRecords.forEachIndexed { index, record ->
                parseLine(index + 1, record, header.currency, problems)?.let { lines += it }
            }
        }

        if (problems.isNotEmpty() || header == null) throw invalid(problems)

        val sum = lines.fold(header.openingMinor) { acc, line -> addOrInvalid(acc, line.amountMinor) }
        if (sum != header.closingMinor) {
            throw BusinessRuleException(
                "statement_unbalanced",
                "Opening balance plus the line amounts does not equal the closing balance.",
                mapOf("expectedClosingMinor" to sum, "closingMinor" to header.closingMinor)
            )
        }
        return ParsedStatement(header, lines)
    }

    private fun readRecords(bytes: ByteArray): List<CSVRecord> {
        val text = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
                .removePrefix("﻿")
        } catch (e: CharacterCodingException) {
            throw invalid(listOf(LineProblem(1, "the file is not valid UTF-8")))
        }
        return try {
            CSVParser.parse(text, CSVFormat.DEFAULT).use { it.records }
        } catch (e: Exception) {
            throw invalid(listOf(LineProblem(1, "the file is not well-formed CSV")))
        }
    }

    private fun parseHeader(record: CSVRecord, expectedCode: String, problems: MutableList<LineProblem>): StatementHeader? {
        val lineNo = record.recordNumber
        if (record.size() != 6 || record.get(0) != "#HEADER") {
            problems += LineProblem(lineNo, "the first record must be #HEADER,code,currency,date,opening,closing")
            return null
        }
        val code = record.get(1).trim()
        if (code != expectedCode) problems += LineProblem(lineNo, "bank account code $code does not match $expectedCode")
        val currency = Currency.parseOrNull(record.get(2).trim())
        if (currency == null) {
            problems += LineProblem(lineNo, "currency ${record.get(2)} is not supported")
            return null
        }
        val date = parseDate(record.get(3).trim())
        if (date == null) problems += LineProblem(lineNo, "statement date must be yyyy-MM-dd")
        val opening = parseAmount(record.get(4).trim(), currency)
        if (opening == null) problems += LineProblem(lineNo, "opening balance is not a valid $currency amount")
        val closing = parseAmount(record.get(5).trim(), currency)
        if (closing == null) problems += LineProblem(lineNo, "closing balance is not a valid $currency amount")
        if (date == null || opening == null || closing == null) return null
        return StatementHeader(code, currency, date, opening, closing)
    }

    private fun checkTrailer(record: CSVRecord, dataLines: Int, problems: MutableList<LineProblem>) {
        if (record.size() != 2 || record.get(0) != "#TRAILER") {
            problems += LineProblem(record.recordNumber, "the last record must be #TRAILER,<data line count>")
            return
        }
        val count = record.get(1).trim().toIntOrNull()
        if (count != dataLines) {
            problems += LineProblem(record.recordNumber, "trailer count ${record.get(1)} does not match $dataLines data lines")
        }
    }

    private fun parseLine(lineNo: Int, record: CSVRecord, currency: Currency, problems: MutableList<LineProblem>): ParsedLine? {
        val recordNo = record.recordNumber
        if (record.size() != COLUMNS.size) {
            problems += LineProblem(recordNo, "expected ${COLUMNS.size} fields, found ${record.size()}")
            return null
        }
        val bankLineId = record.get(0).trim()
        val bookingDate = parseDate(record.get(1).trim())
        val amount = parseAmount(record.get(2).trim(), currency)
        val reference = record.get(3).trim().uppercase()
        val description = record.get(4).trim()
        val before = problems.size
        if (bankLineId.isEmpty() || bankLineId.length > MAX_BANK_LINE_ID) {
            problems += LineProblem(recordNo, "bank_line_id must be 1 to $MAX_BANK_LINE_ID characters")
        }
        if (bookingDate == null) problems += LineProblem(recordNo, "booking_date must be yyyy-MM-dd")
        if (amount == null) {
            problems += LineProblem(recordNo, "amount ${record.get(2)} is not a valid $currency amount")
        } else if (amount == 0L) {
            problems += LineProblem(recordNo, "amount must not be zero")
        }
        if (reference.length > MAX_REFERENCE) problems += LineProblem(recordNo, "reference is longer than $MAX_REFERENCE characters")
        if (description.length > MAX_DESCRIPTION) {
            problems += LineProblem(recordNo, "description is longer than $MAX_DESCRIPTION characters")
        }
        if (problems.size > before || bookingDate == null || amount == null) return null
        return ParsedLine(lineNo, bankLineId, bookingDate, amount, reference, description)
    }

    private fun parseDate(text: String): LocalDate? =
        try {
            if (text.length == 10) LocalDate.parse(text) else null
        } catch (e: DateTimeParseException) {
            null
        }

    private fun parseAmount(text: String, currency: Currency): Long? =
        try {
            MinorUnits.parse(text, currency)
        } catch (e: IllegalArgumentException) {
            null
        }

    private fun addOrInvalid(a: Long, b: Long): Long =
        try {
            Math.addExact(a, b)
        } catch (e: ArithmeticException) {
            throw invalid(listOf(LineProblem(1, "the amounts are out of range")))
        }

    private fun invalid(problems: List<LineProblem>): BusinessRuleException =
        BusinessRuleException(
            "statement_invalid",
            "The statement file is not valid.",
            mapOf("lines" to problems.take(MAX_REPORTED_PROBLEMS), "problemCount" to problems.size)
        )
}
