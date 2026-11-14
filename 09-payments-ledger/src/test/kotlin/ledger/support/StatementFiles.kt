package ledger.support

/** Builds statement CSV files for tests. */
object StatementFiles {
    fun csv(
        code: String,
        currency: String,
        date: String,
        opening: String,
        closing: String,
        lines: List<String>,
        trailerCount: Int = lines.size
    ): String = buildString {
        appendLine("#HEADER,$code,$currency,$date,$opening,$closing")
        appendLine("bank_line_id,booking_date,amount,reference,description")
        lines.forEach { appendLine(it) }
        appendLine("#TRAILER,$trailerCount")
    }
}
