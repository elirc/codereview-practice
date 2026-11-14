package ledger.config

import ledger.domain.Currency
import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

/** Business settings read from the environment at start-up. */
@ConfigurationProperties(prefix = "ledger")
data class LedgerProperties(
    val fxRateMaxAgeSeconds: Long,
    val fxQuoteTtlSeconds: Long,
    val defaultDailyOutMinor: String,
    val minPayoutMinor: String,
    val outboxRetentionHours: Long,
    val expectationOverdueDays: Long
) {
    init {
        require(fxRateMaxAgeSeconds > 0) { "FX_RATE_MAX_AGE_SECONDS must be positive" }
        require(fxQuoteTtlSeconds > 0) { "FX_QUOTE_TTL_SECONDS must be positive" }
        require(outboxRetentionHours > 0) { "OUTBOX_RETENTION_HOURS must be positive" }
        require(expectationOverdueDays > 0) { "EXPECTATION_OVERDUE_DAYS must be positive" }
    }

    val defaultDailyOut: Map<Currency, Long> = parseCurrencyAmounts("DEFAULT_DAILY_OUT_MINOR", defaultDailyOutMinor)
    val minPayout: Map<Currency, Long> = parseCurrencyAmounts("MIN_PAYOUT_MINOR", minPayoutMinor)

    val fxRateMaxAge: Duration get() = Duration.ofSeconds(fxRateMaxAgeSeconds)
    val fxQuoteTtl: Duration get() = Duration.ofSeconds(fxQuoteTtlSeconds)
    val outboxRetention: Duration get() = Duration.ofHours(outboxRetentionHours)
    val expectationOverdue: Duration get() = Duration.ofDays(expectationOverdueDays)

    /** Default daily outbound limit in minor units for [currency]. */
    fun defaultDailyOutFor(currency: Currency): Long = defaultDailyOut.getValue(currency)

    /** Minimum settlement payout in minor units for [currency]. */
    fun minPayoutFor(currency: Currency): Long = minPayout.getValue(currency)

    companion object {
        /** Parses `USD=100,EUR=200,…`; every supported currency must appear exactly once. */
        fun parseCurrencyAmounts(name: String, raw: String): Map<Currency, Long> {
            val result = mutableMapOf<Currency, Long>()
            raw.split(',').map { it.trim() }.filter { it.isNotEmpty() }.forEach { pair ->
                val parts = pair.split('=')
                require(parts.size == 2) { "$name: expected CODE=amount, got '$pair'" }
                val currency = Currency.parseOrNull(parts[0].trim())
                    ?: throw IllegalArgumentException("$name: unsupported currency '${parts[0]}'")
                val amount = parts[1].trim().toLongOrNull()
                    ?: throw IllegalArgumentException("$name: '${parts[1]}' is not an integer")
                require(amount >= 0) { "$name: amount for $currency must not be negative" }
                require(result.put(currency, amount) == null) { "$name: $currency listed twice" }
            }
            val missing = Currency.entries.filter { it !in result }
            require(missing.isEmpty()) { "$name: missing values for $missing" }
            return result.toMap()
        }
    }
}
