package ledger.transfers

import ledger.config.IdSource
import ledger.config.Tx
import ledger.domain.BusinessRuleException
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.domain.EntryKind
import ledger.domain.Errors
import ledger.domain.PostingLine
import ledger.domain.Role
import ledger.domain.SystemRole
import ledger.domain.utcDate
import ledger.ledger.Account
import ledger.ledger.Accounts
import ledger.ledger.JournalEntry
import ledger.ledger.LedgerService
import ledger.ledger.NewEntry
import ledger.ledger.requireCustomerFacing
import ledger.limits.LimitService
import ledger.settlement.BankExpectations
import ledger.settlement.ExpectationKind
import org.springframework.stereotype.Service
import java.time.Clock
import java.util.UUID

data class TransferCommand(val fromAccountId: UUID, val toAccountId: UUID, val amountMinor: Long, val currency: Currency)

data class WithdrawalCommand(val accountId: UUID, val amountMinor: Long, val currency: Currency)

/** Moves money between customer accounts and out to the bank. */
@Service
class TransferService(
    private val tx: Tx,
    private val accounts: Accounts,
    private val ledger: LedgerService,
    private val limits: LimitService,
    private val expectations: BankExpectations,
    private val ids: IdSource,
    private val clock: Clock
) {
    /** Transfers the amount from one wallet or merchant account to another and returns the entry. */
    fun transfer(caller: Caller, command: TransferCommand): JournalEntry {
        caller.require(Role.SERVICE)
        if (command.fromAccountId == command.toAccountId) {
            throw BusinessRuleException("same_account", "The source and destination accounts must differ.")
        }
        return tx.inTx {
            val from = accounts.get(command.fromAccountId)
            val to = accounts.get(command.toAccountId)
            requireCustomerFacing(from)
            requireCustomerFacing(to)
            requireCurrency(from, command.currency)
            requireCurrency(to, command.currency)
            if (from.ownerId != to.ownerId) {
                limits.consume(from.ownerId!!, command.currency, clock.instant().utcDate(), command.amountMinor)
            }
            ledger.post(
                NewEntry(
                    kind = EntryKind.TRANSFER,
                    lines = listOf(
                        PostingLine(from.id, -command.amountMinor, command.currency),
                        PostingLine(to.id, command.amountMinor, command.currency)
                    ),
                    actorKeyId = caller.keyId
                )
            )
        }
    }

    /** Moves the amount from a wallet or merchant account to payout clearing and opens a bank expectation. */
    fun withdraw(caller: Caller, command: WithdrawalCommand): JournalEntry {
        caller.require(Role.SERVICE)
        return tx.inTx {
            val account = accounts.get(command.accountId)
            requireCustomerFacing(account)
            requireCurrency(account, command.currency)
            limits.consume(account.ownerId!!, command.currency, clock.instant().utcDate(), command.amountMinor)
            val clearing = accounts.system(SystemRole.PAYOUT_CLEARING, command.currency)
            val entry = ledger.post(
                NewEntry(
                    kind = EntryKind.WITHDRAWAL,
                    lines = listOf(
                        PostingLine(account.id, -command.amountMinor, command.currency),
                        PostingLine(clearing.id, command.amountMinor, command.currency)
                    ),
                    actorKeyId = caller.keyId
                )
            )
            expectations.create(
                kind = ExpectationKind.WITHDRAWAL,
                reference = WITHDRAWAL_PREFIX + ids.base32(WITHDRAWAL_REFERENCE_LENGTH),
                accountId = account.id,
                amountMinor = command.amountMinor,
                currency = command.currency,
                sourceEntryId = entry.id,
                at = entry.createdAt
            )
            entry
        }
    }

    private fun requireCurrency(account: Account, currency: Currency) {
        if (account.currency != currency) {
            throw Errors.currencyMismatch("Account ${account.id} holds ${account.currency}, not $currency.")
        }
    }

    private companion object {
        const val WITHDRAWAL_PREFIX = "WDR-"
        const val WITHDRAWAL_REFERENCE_LENGTH = 12
    }
}
