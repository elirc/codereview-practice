package ledger.ledger

import ledger.config.uuid
import ledger.config.uuidOrNull
import ledger.domain.Currency
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import java.util.UUID

/** A balance together with the owner of its account. */
data class OwnedBalance(val ownerId: UUID?, val view: BalanceView)

/** Reads balances joined with their accounts for the API. */
@Component
class BalanceViews(private val jdbc: JdbcClient) {
    /** Returns the balance of one account with its owner, or null when the account does not exist. */
    fun find(accountId: UUID): OwnedBalance? =
        jdbc.sql(
            """
            SELECT a.id, a.owner_id, a.currency, b.posted_minor, b.held_minor, b.version
            FROM accounts a
            JOIN account_balances b ON b.account_id = a.id
            WHERE a.id = :accountId
            """.trimIndent()
        )
            .param("accountId", accountId)
            .query(MAPPER)
            .optional()
            .orElse(null)

    /** Returns the balances of every account of [ownerId], ordered by currency and account id. */
    fun forOwner(ownerId: UUID): List<BalanceView> =
        jdbc.sql(
            """
            SELECT a.id, a.owner_id, a.currency, b.posted_minor, b.held_minor, b.version
            FROM accounts a
            JOIN account_balances b ON b.account_id = a.id
            WHERE a.owner_id = :ownerId
            ORDER BY a.currency, a.id
            """.trimIndent()
        )
            .param("ownerId", ownerId)
            .query(MAPPER)
            .list()
            .map { it.view }

    private companion object {
        val MAPPER = RowMapper { rs, _ ->
            val posted = rs.getLong("posted_minor")
            val held = rs.getLong("held_minor")
            OwnedBalance(
                ownerId = rs.uuidOrNull("owner_id"),
                view = BalanceView(
                    accountId = rs.uuid("id"),
                    postedMinor = posted,
                    heldMinor = held,
                    availableMinor = posted - held,
                    currency = Currency.fromDb(rs.getString("currency")),
                    version = rs.getLong("version")
                )
            )
        }
    }
}
