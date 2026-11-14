package ledger.ledger

import ledger.config.IdSource
import ledger.config.PgErrors
import ledger.config.Tx
import ledger.domain.AccountStatus
import ledger.domain.AccountType
import ledger.domain.BusinessRuleException
import ledger.domain.Caller
import ledger.domain.ConflictException
import ledger.domain.Currency
import ledger.domain.Errors
import ledger.domain.Page
import ledger.domain.PageRequest
import ledger.domain.Role
import ledger.domain.validationFailed
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.stereotype.Service
import java.time.Clock
import java.util.UUID

data class CreateAccountCommand(
    val ownerId: UUID,
    val type: AccountType,
    val currency: Currency,
    val feeBps: Int?,
    val payoutEnabled: Boolean?
)

/** The balance of one account as returned by the API. */
data class BalanceView(
    val accountId: UUID,
    val postedMinor: Long,
    val heldMinor: Long,
    val availableMinor: Long,
    val currency: Currency,
    val version: Long
)

/** Creates accounts and answers questions about them. */
@Service
class AccountService(
    private val tx: Tx,
    private val accounts: Accounts,
    private val balances: BalanceStore,
    private val entries: EntryQueries,
    private val ids: IdSource,
    private val clock: Clock
) {
    /** Creates a customer wallet or merchant account with a zero balance and returns it. */
    fun create(caller: Caller, command: CreateAccountCommand): Account {
        caller.require(Role.SERVICE, Role.OPERATOR)
        if (command.type == AccountType.SYSTEM) {
            throw Errors.invalidAccountType("System accounts cannot be created through the API.")
        }
        val merchant = command.type == AccountType.MERCHANT
        if (!merchant && command.feeBps != null) throw validationFailed("feeBps", "is only allowed for merchant accounts")
        if (!merchant && command.payoutEnabled != null) {
            throw validationFailed("payoutEnabled", "is only allowed for merchant accounts")
        }
        val account = Account(
            id = ids.uuid(),
            ownerId = command.ownerId,
            type = command.type,
            systemRole = null,
            currency = command.currency,
            status = AccountStatus.ACTIVE,
            allowNegative = false,
            depositReference = DEPOSIT_PREFIX + ids.base32(DEPOSIT_REFERENCE_LENGTH),
            feeBps = if (merchant) command.feeBps ?: 0 else null,
            payoutEnabled = if (merchant) command.payoutEnabled ?: true else null,
            createdAt = clock.instant()
        )
        return tx.inTx {
            try {
                accounts.insert(account)
            } catch (e: DataIntegrityViolationException) {
                if (PgErrors.isConstraint(e, "accounts_owner_type_currency_key")) {
                    throw ConflictException(
                        "invalid_state",
                        "Owner ${command.ownerId} already has a ${command.type.wire} account in ${command.currency}.",
                        mapOf("ownerId" to command.ownerId)
                    )
                }
                throw e
            }
            balances.create(account.id, allowNegative = false)
            account
        }
    }

    /** Returns an account the caller may see. */
    fun get(caller: Caller, id: UUID): Account = visible(caller, accounts.get(id))

    /** Lists accounts the caller may see, optionally for one owner. */
    fun list(caller: Caller, ownerId: UUID?, page: PageRequest): Page<Account> {
        val after = page.after?.let { parseUuidCursor(it) }
        val owner = if (caller.isMerchant) caller.ownerId else ownerId
        if (caller.isMerchant && ownerId != null && ownerId != caller.ownerId) return Page(emptyList(), null)
        val rows = accounts.list(owner, after, page.limit + 1)
        return Page.fromFetched(rows, page.limit) { it.id.toString() }
    }

    /** Returns the balance of an account the caller may see. */
    fun balance(caller: Caller, id: UUID): BalanceView {
        val account = get(caller, id)
        val row = balances.read(id) ?: throw Errors.accountNotFound(id)
        return BalanceView(id, row.postedMinor, row.heldMinor, row.availableMinor, account.currency, row.version)
    }

    /** Lists the postings of an account the caller may see. */
    fun postings(caller: Caller, id: UUID, page: PageRequest): Page<AccountPosting> {
        get(caller, id)
        val after = page.after?.let { PostingCursor.parse(it) }
        val rows = entries.postingsForAccount(id, after, page.limit + 1)
        return Page.fromFetched(rows, page.limit) { it.cursor }
    }

    /** Returns [account] when the caller may see it; merchants see only their own accounts. */
    fun visible(caller: Caller, account: Account): Account {
        if (caller.isMerchant && account.ownerId != caller.ownerId) throw Errors.accountNotFound(account.id)
        return account
    }

    private fun parseUuidCursor(raw: String): UUID =
        try {
            UUID.fromString(raw)
        } catch (e: IllegalArgumentException) {
            throw validationFailed("after", "is not a valid cursor")
        }

    private companion object {
        const val DEPOSIT_PREFIX = "DEP-"
        const val DEPOSIT_REFERENCE_LENGTH = 10
    }
}

/** Rejects accounts that API transfers, holds and withdrawals may not use. */
internal fun requireCustomerFacing(account: Account) {
    if (!account.isCustomerFacing) {
        throw BusinessRuleException(
            "invalid_account_type",
            "Account ${account.id} of type ${account.type.wire} cannot be used here.",
            mapOf("accountId" to account.id)
        )
    }
}
