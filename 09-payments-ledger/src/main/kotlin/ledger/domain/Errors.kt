package ledger.domain

import java.util.UUID

/** Builders for errors raised in several places. */
object Errors {
    fun insufficientFunds(accountId: UUID, availableMinor: Long): BusinessRuleException =
        BusinessRuleException(
            "insufficient_funds",
            "Account $accountId does not have enough available funds.",
            mapOf("accountId" to accountId, "availableMinor" to availableMinor)
        )

    fun accountClosed(accountId: UUID): BusinessRuleException =
        BusinessRuleException("account_closed", "Account $accountId is closed.", mapOf("accountId" to accountId))

    fun accountFrozen(accountId: UUID): BusinessRuleException =
        BusinessRuleException("account_frozen", "Account $accountId is frozen.", mapOf("accountId" to accountId))

    fun currencyMismatch(message: String): BusinessRuleException = BusinessRuleException("currency_mismatch", message)

    fun invalidAccountType(message: String): BusinessRuleException = BusinessRuleException("invalid_account_type", message)

    fun accountNotFound(accountId: UUID): NotFoundException = NotFoundException("Account $accountId was not found.")
}
