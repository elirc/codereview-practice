package ledger.domain

/** Supported ISO-4217 currencies with their minor-unit exponents. */
enum class Currency(val exponent: Int) {
    USD(2),
    EUR(2),
    GBP(2),
    JPY(0),
    KWD(3);

    companion object {
        /** Returns the currency for an ISO code, or null when it is not supported. */
        fun parseOrNull(code: String): Currency? = entries.firstOrNull { it.name == code }

        /** Returns the currency stored in a database column. */
        fun fromDb(code: String): Currency = valueOf(code)
    }
}
