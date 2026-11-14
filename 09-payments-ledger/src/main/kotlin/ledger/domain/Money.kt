package ledger.domain

import java.math.BigDecimal

/** An amount in minor units of [currency]. */
data class Money(val minor: Long, val currency: Currency) {
    /** Formats the amount as a decimal string with the currency's exponent, for example `-12.50`. */
    fun format(): String = MinorUnits.format(minor, currency)

    operator fun plus(other: Money): Money {
        require(currency == other.currency) { "cannot add $currency and ${other.currency}" }
        return Money(Math.addExact(minor, other.minor), currency)
    }

    operator fun unaryMinus(): Money = Money(Math.negateExact(minor), currency)

    companion object {
        /** Parses a decimal string with exactly the currency's number of decimals. */
        fun parse(text: String, currency: Currency): Money = Money(MinorUnits.parse(text, currency), currency)
    }
}

/** Conversion between decimal strings and minor-unit counts. */
object MinorUnits {
    private val patterns: Map<Int, Regex> = Currency.entries.map { it.exponent }.distinct().associateWith { exponent ->
        if (exponent == 0) Regex("-?(0|[1-9][0-9]*)") else Regex("-?(0|[1-9][0-9]*)\\.[0-9]{$exponent}")
    }

    /**
     * Parses [text] as a signed decimal with exactly [Currency.exponent] fractional digits and returns minor units.
     * Throws [IllegalArgumentException] for any other shape or for values outside the `Long` range.
     */
    fun parse(text: String, currency: Currency): Long {
        val pattern = patterns.getValue(currency.exponent)
        require(pattern.matches(text)) {
            if (currency.exponent == 0) {
                "'$text' is not a whole amount for $currency"
            } else {
                "'$text' is not an amount with ${currency.exponent} decimals for $currency"
            }
        }
        return try {
            BigDecimal(text).movePointRight(currency.exponent).longValueExact()
        } catch (e: ArithmeticException) {
            throw IllegalArgumentException("'$text' is out of range")
        }
    }

    /** Formats [minor] units of [currency] as a plain decimal string. */
    fun format(minor: Long, currency: Currency): String = BigDecimal.valueOf(minor, currency.exponent).toPlainString()
}
