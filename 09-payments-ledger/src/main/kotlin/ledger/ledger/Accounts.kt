package ledger.ledger

import com.fasterxml.jackson.annotation.JsonIgnore
import ledger.config.booleanOrNull
import ledger.config.instant
import ledger.config.intOrNull
import ledger.config.toDb
import ledger.config.uuid
import ledger.config.uuidOrNull
import ledger.domain.AccountStatus
import ledger.domain.AccountType
import ledger.domain.Currency
import ledger.domain.Errors
import ledger.domain.SystemRole
import ledger.domain.wireValueOf
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import java.time.Instant
import java.util.UUID

data class Account(
    val id: UUID,
    val ownerId: UUID?,
    val type: AccountType,
    val systemRole: SystemRole?,
    val currency: Currency,
    val status: AccountStatus,
    val allowNegative: Boolean,
    val depositReference: String?,
    val feeBps: Int?,
    val payoutEnabled: Boolean?,
    val createdAt: Instant
) {
    /** True for customer wallets and merchant accounts, the accounts API transfers may use. */
    @get:JsonIgnore
    val isCustomerFacing: Boolean get() = type == AccountType.CUSTOMER_WALLET || type == AccountType.MERCHANT
}

/** Reads and writes rows of the `accounts` table. */
@Component
class Accounts(private val jdbc: JdbcClient) {
    fun find(id: UUID): Account? =
        jdbc.sql("SELECT * FROM accounts WHERE id = :id")
            .param("id", id)
            .query(MAPPER)
            .optional()
            .orElse(null)

    /** Returns the account or throws `not_found`. */
    fun get(id: UUID): Account = find(id) ?: throw Errors.accountNotFound(id)

    fun findAll(ids: Collection<UUID>): Map<UUID, Account> {
        if (ids.isEmpty()) return emptyMap()
        return jdbc.sql("SELECT * FROM accounts WHERE id IN (:ids)")
            .param("ids", ids.toSet())
            .query(MAPPER)
            .list()
            .associateBy { it.id }
    }

    /** Returns the system account for [role] in [currency]. */
    fun system(role: SystemRole, currency: Currency): Account =
        jdbc.sql("SELECT * FROM accounts WHERE system_role = :role AND currency = :currency")
            .param("role", role.wire)
            .param("currency", currency.name)
            .query(MAPPER)
            .single()

    fun byDepositReference(reference: String): Account? =
        jdbc.sql("SELECT * FROM accounts WHERE deposit_reference = :reference")
            .param("reference", reference)
            .query(MAPPER)
            .optional()
            .orElse(null)

    /** Lists accounts ordered by id, optionally restricted to one owner. */
    fun list(ownerId: UUID?, after: UUID?, limit: Int): List<Account> {
        val conditions = mutableListOf<String>()
        val params = mutableMapOf<String, Any>("limit" to limit)
        if (ownerId != null) {
            conditions += "owner_id = :ownerId"
            params["ownerId"] = ownerId
        }
        if (after != null) {
            conditions += "id > :after"
            params["after"] = after
        }
        val where = if (conditions.isEmpty()) "" else "WHERE " + conditions.joinToString(" AND ")
        return jdbc.sql("SELECT * FROM accounts $where ORDER BY id LIMIT :limit")
            .params(params)
            .query(MAPPER)
            .list()
    }

    /** Returns the ids of all merchant accounts in [currency], ordered by id. */
    fun merchantIds(currency: Currency): List<UUID> =
        jdbc.sql("SELECT id FROM accounts WHERE type = 'merchant' AND currency = :currency ORDER BY id")
            .param("currency", currency.name)
            .query { rs, _ -> rs.uuid("id") }
            .list()

    fun insert(account: Account) {
        jdbc.sql(
            """
            INSERT INTO accounts (id, owner_id, type, system_role, currency, status, allow_negative,
                                  deposit_reference, fee_bps, payout_enabled, created_at)
            VALUES (:id, :ownerId, :type, :systemRole, :currency, :status, :allowNegative,
                    :depositReference, :feeBps, :payoutEnabled, :createdAt)
            """.trimIndent()
        )
            .param("id", account.id)
            .param("ownerId", account.ownerId)
            .param("type", account.type.wire)
            .param("systemRole", account.systemRole?.wire)
            .param("currency", account.currency.name)
            .param("status", account.status.wire)
            .param("allowNegative", account.allowNegative)
            .param("depositReference", account.depositReference)
            .param("feeBps", account.feeBps)
            .param("payoutEnabled", account.payoutEnabled)
            .param("createdAt", account.createdAt.toDb())
            .update()
    }

    fun updateStatus(id: UUID, status: AccountStatus) {
        jdbc.sql("UPDATE accounts SET status = :status WHERE id = :id")
            .param("status", status.wire)
            .param("id", id)
            .update()
    }

    companion object {
        val MAPPER = RowMapper { rs, _ ->
            Account(
                id = rs.uuid("id"),
                ownerId = rs.uuidOrNull("owner_id"),
                type = wireValueOf<AccountType>(rs.getString("type")),
                systemRole = rs.getString("system_role")?.let { wireValueOf<SystemRole>(it) },
                currency = Currency.fromDb(rs.getString("currency")),
                status = wireValueOf<AccountStatus>(rs.getString("status")),
                allowNegative = rs.getBoolean("allow_negative"),
                depositReference = rs.getString("deposit_reference"),
                feeBps = rs.intOrNull("fee_bps"),
                payoutEnabled = rs.booleanOrNull("payout_enabled"),
                createdAt = rs.instant("created_at")
            )
        }
    }
}
