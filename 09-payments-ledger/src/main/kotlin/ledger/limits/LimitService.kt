package ledger.limits

import ledger.config.LedgerProperties
import ledger.config.Tx
import ledger.config.toDb
import ledger.domain.BusinessRuleException
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.domain.Role
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.LocalDate
import java.util.UUID

data class OwnerLimit(val ownerId: UUID, val currency: Currency, val dailyOutMinor: Long)

/** Daily outbound limits per owner and currency, and the usage counted against them. */
@Service
class LimitService(
    private val tx: Tx,
    private val jdbc: JdbcClient,
    private val properties: LedgerProperties,
    private val clock: Clock
) {
    /** Sets the owner's daily outbound limit for [currency] and returns it. */
    fun setLimit(caller: Caller, ownerId: UUID, currency: Currency, dailyOutMinor: Long): OwnerLimit {
        caller.require(Role.OPERATOR)
        tx.inTx {
            jdbc.sql(
                """
                INSERT INTO owner_limits (owner_id, currency, daily_out_minor, updated_at, updated_by)
                VALUES (:ownerId, :currency, :limit, :now, :keyId)
                ON CONFLICT (owner_id, currency) DO UPDATE
                SET daily_out_minor = EXCLUDED.daily_out_minor,
                    updated_at = EXCLUDED.updated_at,
                    updated_by = EXCLUDED.updated_by
                """.trimIndent()
            )
                .param("ownerId", ownerId)
                .param("currency", currency.name)
                .param("limit", dailyOutMinor)
                .param("now", clock.instant().toDb())
                .param("keyId", caller.keyId)
                .update()
        }
        return OwnerLimit(ownerId, currency, dailyOutMinor)
    }

    /** Returns the owner's daily limit for [currency], or the configured default when none is set. */
    fun limitFor(ownerId: UUID, currency: Currency): Long =
        jdbc.sql("SELECT daily_out_minor FROM owner_limits WHERE owner_id = :ownerId AND currency = :currency")
            .param("ownerId", ownerId)
            .param("currency", currency.name)
            .query(Long::class.javaObjectType)
            .optional()
            .orElse(properties.defaultDailyOutFor(currency))

    /**
     * Adds [amountMinor] to the owner's usage for [day] in the caller's transaction.
     * Throws `daily_limit_exceeded` when the new total would be above the limit.
     */
    fun consume(ownerId: UUID, currency: Currency, day: LocalDate, amountMinor: Long) {
        val used = jdbc.sql(
            """
            INSERT INTO owner_daily_usage (owner_id, currency, day, used_minor)
            VALUES (:ownerId, :currency, :day, 0)
            ON CONFLICT (owner_id, currency, day) DO UPDATE SET used_minor = owner_daily_usage.used_minor
            RETURNING used_minor
            """.trimIndent()
        )
            .param("ownerId", ownerId)
            .param("currency", currency.name)
            .param("day", day)
            .query(Long::class.javaObjectType)
            .single()
        val limit = limitFor(ownerId, currency)
        if (Math.addExact(used, amountMinor) > limit) {
            throw BusinessRuleException(
                "daily_limit_exceeded",
                "The daily outbound limit for owner $ownerId in $currency would be exceeded.",
                mapOf("remainingMinor" to maxOf(0L, limit - used))
            )
        }
        updateUsage(ownerId, currency, day, amountMinor)
    }

    /** Subtracts [amountMinor] from the owner's usage for [day] in the caller's transaction. */
    fun giveBack(ownerId: UUID, currency: Currency, day: LocalDate, amountMinor: Long) {
        check(updateUsage(ownerId, currency, day, -amountMinor) == 1) { "no usage row for $ownerId $currency $day" }
    }

    /** Returns the owner's usage for [day], zero when nothing was counted. */
    fun usage(ownerId: UUID, currency: Currency, day: LocalDate): Long =
        jdbc.sql("SELECT used_minor FROM owner_daily_usage WHERE owner_id = :ownerId AND currency = :currency AND day = :day")
            .param("ownerId", ownerId)
            .param("currency", currency.name)
            .param("day", day)
            .query(Long::class.javaObjectType)
            .optional()
            .orElse(0L)

    private fun updateUsage(ownerId: UUID, currency: Currency, day: LocalDate, delta: Long): Int =
        jdbc.sql(
            """
            UPDATE owner_daily_usage SET used_minor = used_minor + :delta
            WHERE owner_id = :ownerId AND currency = :currency AND day = :day
            """.trimIndent()
        )
            .param("delta", delta)
            .param("ownerId", ownerId)
            .param("currency", currency.name)
            .param("day", day)
            .update()
}
