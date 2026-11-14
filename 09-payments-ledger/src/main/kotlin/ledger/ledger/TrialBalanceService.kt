package ledger.ledger

import ledger.config.Tx
import ledger.config.uuid
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.domain.Role
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import java.util.UUID

data class PostedDrift(val accountId: UUID, val postedMinor: Long, val postingsSumMinor: Long)

data class HeldDrift(val accountId: UUID, val heldMinor: Long, val activeHoldsMinor: Long)

data class CurrencyTrialBalance(
    val currency: Currency,
    val postedSumMinor: Long,
    val postingsSumMinor: Long,
    val driftingAccounts: List<PostedDrift>,
    val heldDriftingAccounts: List<HeldDrift>
)

data class TrialBalance(val currencies: List<CurrencyTrialBalance>, val balanced: Boolean)

/** Checks the ledger against its invariants from one consistent snapshot. */
@Service
class TrialBalanceService(private val tx: Tx, private val jdbc: JdbcClient) {
    /** Returns per currency the sums of balances and postings and every account whose stored balance has drifted. */
    fun trialBalance(caller: Caller): TrialBalance {
        caller.require(Role.OPERATOR, Role.AUDITOR)
        return tx.readSnapshot {
            val postedSums = sumsByCurrency(
                """
                SELECT a.currency, sum(b.posted_minor) AS total
                FROM account_balances b
                JOIN accounts a ON a.id = b.account_id
                GROUP BY a.currency
                """.trimIndent()
            )
            val postingSums = sumsByCurrency("SELECT currency, sum(amount_minor) AS total FROM postings GROUP BY currency")
            val posted = postedDrift()
            val held = heldDrift()
            val currencies = Currency.entries.map { currency ->
                CurrencyTrialBalance(
                    currency = currency,
                    postedSumMinor = postedSums[currency] ?: 0L,
                    postingsSumMinor = postingSums[currency] ?: 0L,
                    driftingAccounts = posted[currency].orEmpty(),
                    heldDriftingAccounts = held[currency].orEmpty()
                )
            }
            val balanced = currencies.all {
                it.postedSumMinor == 0L &&
                    it.postingsSumMinor == 0L &&
                    it.driftingAccounts.isEmpty() &&
                    it.heldDriftingAccounts.isEmpty()
            }
            TrialBalance(currencies, balanced)
        }
    }

    private fun sumsByCurrency(sql: String): Map<Currency, Long> =
        jdbc.sql(sql)
            .query { rs, _ -> Currency.fromDb(rs.getString("currency")) to rs.getLong("total") }
            .list()
            .toMap()

    private fun postedDrift(): Map<Currency, List<PostedDrift>> =
        jdbc.sql(
            """
            SELECT a.id, a.currency, b.posted_minor, COALESCE(p.total, 0) AS postings_total
            FROM accounts a
            JOIN account_balances b ON b.account_id = a.id
            LEFT JOIN (SELECT account_id, sum(amount_minor) AS total FROM postings GROUP BY account_id) p ON p.account_id = a.id
            WHERE b.posted_minor <> COALESCE(p.total, 0)
            ORDER BY a.id
            """.trimIndent()
        )
            .query { rs, _ ->
                Currency.fromDb(rs.getString("currency")) to
                    PostedDrift(rs.uuid("id"), rs.getLong("posted_minor"), rs.getLong("postings_total"))
            }
            .list()
            .groupBy({ it.first }, { it.second })

    private fun heldDrift(): Map<Currency, List<HeldDrift>> =
        jdbc.sql(
            """
            SELECT a.id, a.currency, b.held_minor, COALESCE(h.total, 0) AS holds_total
            FROM accounts a
            JOIN account_balances b ON b.account_id = a.id
            LEFT JOIN (
                SELECT account_id, sum(amount_minor) AS total FROM holds WHERE status = 'active' GROUP BY account_id
            ) h ON h.account_id = a.id
            WHERE b.held_minor <> COALESCE(h.total, 0)
            ORDER BY a.id
            """.trimIndent()
        )
            .query { rs, _ ->
                Currency.fromDb(rs.getString("currency")) to
                    HeldDrift(rs.uuid("id"), rs.getLong("held_minor"), rs.getLong("holds_total"))
            }
            .list()
            .groupBy({ it.first }, { it.second })
}
