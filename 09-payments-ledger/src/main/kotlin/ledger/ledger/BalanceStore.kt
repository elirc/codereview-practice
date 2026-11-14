package ledger.ledger

import ledger.config.PgErrors
import ledger.config.uuid
import ledger.domain.Errors
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import java.util.UUID

/** One row of `account_balances`. */
data class BalanceRow(val accountId: UUID, val postedMinor: Long, val heldMinor: Long, val version: Long) {
    val availableMinor: Long get() = postedMinor - heldMinor
}

/** An account together with its balance row, read while the row is locked. */
data class LockedAccount(val account: Account, val balance: BalanceRow)

/** The balance rows locked by one operation, keyed by account id. */
class LockSet(private val rows: Map<UUID, LockedAccount>) {
    val accountIds: Set<UUID> get() = rows.keys

    operator fun get(accountId: UUID): LockedAccount =
        rows[accountId] ?: throw IllegalStateException("account $accountId is not part of this lock set")

    fun containsAll(accountIds: Collection<UUID>): Boolean = rows.keys.containsAll(accountIds)
}

/** Locks and updates rows of `account_balances`. */
@Component
class BalanceStore(private val jdbc: JdbcClient, private val accounts: Accounts) {
    /** Locks the balance rows of [accountIds] and returns them with their accounts; throws `not_found` for a missing account. */
    fun lock(accountIds: Collection<UUID>): LockSet {
        val ids = accountIds.toSet()
        require(ids.isNotEmpty()) { "nothing to lock" }
        val rows = jdbc.sql(
            """
            SELECT account_id, posted_minor, held_minor, version
            FROM account_balances
            WHERE account_id IN (:ids)
            ORDER BY account_id
            FOR UPDATE
            """.trimIndent()
        )
            .param("ids", ids)
            .query(MAPPER)
            .list()
        if (rows.size != ids.size) {
            val missing = ids - rows.map { it.accountId }.toSet()
            throw Errors.accountNotFound(missing.first())
        }
        val details = accounts.findAll(ids)
        return LockSet(rows.associate { row -> row.accountId to LockedAccount(details.getValue(row.accountId), row) })
    }

    /**
     * Adds [postedDelta] and [heldDelta] to a locked balance row, increments its version and returns the new row.
     * [availableBefore] is reported when the account would drop below zero available.
     */
    fun apply(accountId: UUID, postedDelta: Long, heldDelta: Long, availableBefore: Long): BalanceRow {
        try {
            return jdbc.sql(
                """
                UPDATE account_balances
                SET posted_minor = posted_minor + :postedDelta,
                    held_minor = held_minor + :heldDelta,
                    version = version + 1
                WHERE account_id = :accountId
                RETURNING account_id, posted_minor, held_minor, version
                """.trimIndent()
            )
                .param("postedDelta", postedDelta)
                .param("heldDelta", heldDelta)
                .param("accountId", accountId)
                .query(MAPPER)
                .single()
        } catch (e: DataIntegrityViolationException) {
            if (PgErrors.isConstraint(e, AVAILABLE_CHECK)) throw Errors.insufficientFunds(accountId, availableBefore)
            throw e
        }
    }

    /** Increments the version of a locked balance row without changing amounts and returns the new row. */
    fun bumpVersion(accountId: UUID): BalanceRow =
        jdbc.sql(
            """
            UPDATE account_balances SET version = version + 1
            WHERE account_id = :accountId
            RETURNING account_id, posted_minor, held_minor, version
            """.trimIndent()
        )
            .param("accountId", accountId)
            .query(MAPPER)
            .single()

    /** Creates the zero balance row of a new account. */
    fun create(accountId: UUID, allowNegative: Boolean) {
        jdbc.sql(
            """
            INSERT INTO account_balances (account_id, posted_minor, held_minor, version, allow_negative)
            VALUES (:accountId, 0, 0, 0, :allowNegative)
            """.trimIndent()
        )
            .param("accountId", accountId)
            .param("allowNegative", allowNegative)
            .update()
    }

    /** Reads a balance row without locking it. */
    fun read(accountId: UUID): BalanceRow? =
        jdbc.sql("SELECT account_id, posted_minor, held_minor, version FROM account_balances WHERE account_id = :accountId")
            .param("accountId", accountId)
            .query(MAPPER)
            .optional()
            .orElse(null)

    private companion object {
        const val AVAILABLE_CHECK = "account_balances_available_check"

        val MAPPER = RowMapper { rs, _ ->
            BalanceRow(
                accountId = rs.uuid("account_id"),
                postedMinor = rs.getLong("posted_minor"),
                heldMinor = rs.getLong("held_minor"),
                version = rs.getLong("version")
            )
        }
    }
}
