package ledger.holds

import ledger.config.IdSource
import ledger.config.Tx
import ledger.domain.AccountStatus
import ledger.domain.AccountType
import ledger.domain.BusinessRuleException
import ledger.domain.Caller
import ledger.domain.ConflictException
import ledger.domain.Currency
import ledger.domain.EntryKind
import ledger.domain.Errors
import ledger.domain.Fees
import ledger.domain.NotFoundException
import ledger.domain.PostingLine
import ledger.domain.Role
import ledger.domain.SystemRole
import ledger.domain.utcDate
import ledger.ledger.Account
import ledger.ledger.Accounts
import ledger.ledger.BalanceStore
import ledger.ledger.LedgerService
import ledger.ledger.NewEntry
import ledger.limits.LimitService
import ledger.outbox.CauseType
import ledger.outbox.LedgerEvents
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.Instant
import java.util.UUID

data class AuthorizeCommand(
    val accountId: UUID,
    val merchantAccountId: UUID,
    val amountMinor: Long,
    val currency: Currency,
    val expiresInSeconds: Long
)

/** Authorises, captures, releases and expires holds on customer wallets. */
@Service
class HoldService(
    private val tx: Tx,
    private val holds: HoldStore,
    private val accounts: Accounts,
    private val balances: BalanceStore,
    private val ledger: LedgerService,
    private val limits: LimitService,
    private val events: LedgerEvents,
    private val ids: IdSource,
    private val clock: Clock
) {
    /** Reserves the amount on a wallet for a merchant and returns the active hold. */
    fun authorize(caller: Caller, command: AuthorizeCommand): Hold {
        caller.require(Role.SERVICE)
        return tx.inTx {
            val wallet = accounts.get(command.accountId)
            val merchant = accounts.get(command.merchantAccountId)
            if (wallet.type != AccountType.CUSTOMER_WALLET) {
                throw Errors.invalidAccountType("Holds can only be placed on customer wallets.")
            }
            if (merchant.type != AccountType.MERCHANT) {
                throw Errors.invalidAccountType("Account ${merchant.id} is not a merchant account.")
            }
            if (wallet.currency != command.currency || merchant.currency != command.currency) {
                throw Errors.currencyMismatch("The wallet, merchant account and hold must share one currency.")
            }
            requireActive(merchant)

            val now = clock.instant()
            val today = now.utcDate()
            limits.consume(wallet.ownerId!!, command.currency, today, command.amountMinor)

            val locked = balances.lock(listOf(wallet.id))[wallet.id]
            requireActive(locked.account)
            val available = locked.balance.availableMinor
            if (available < command.amountMinor) throw Errors.insufficientFunds(wallet.id, available)

            val hold = Hold(
                id = ids.uuid(),
                accountId = wallet.id,
                merchantAccountId = merchant.id,
                amountMinor = command.amountMinor,
                capturedMinor = 0,
                currency = command.currency,
                status = HoldStatus.ACTIVE,
                expiresAt = now.plusSeconds(command.expiresInSeconds),
                authorizedOn = today,
                captureEntryId = null,
                version = 1,
                createdAt = now,
                updatedAt = now
            )
            val balance = balances.apply(wallet.id, 0, command.amountMinor, available)
            events.balanceChanged(locked.account, balance, CauseType.HOLD, hold.id, now)
            holds.insert(hold)
            events.hold(HOLD_AUTHORIZED, hold, now)
            hold
        }
    }

    /** Returns a hold the caller may see. */
    fun get(caller: Caller, id: UUID): Hold {
        val hold = holds.find(id) ?: throw holdNotFound(id)
        requireVisible(caller, hold)
        return hold
    }

    /**
     * Captures [amountMinor] of an active, unexpired hold: the whole hold leaves `heldMinor`, the captured amount
     * is posted to the merchant less its fee, and the hold becomes `captured`.
     */
    fun capture(caller: Caller, id: UUID, amountMinor: Long): Hold {
        caller.require(Role.SERVICE, Role.MERCHANT, Role.OPERATOR)
        return tx.inTx {
            val hold = holds.lock(id) ?: throw holdNotFound(id)
            requireVisible(caller, hold)
            val now = clock.instant()
            requireCapturable(hold, now)
            if (amountMinor > hold.amountMinor) {
                throw BusinessRuleException(
                    "capture_exceeds_hold",
                    "The capture amount exceeds the held amount.",
                    mapOf("holdAmountMinor" to hold.amountMinor)
                )
            }

            val merchant = accounts.get(hold.merchantAccountId)
            val fee = Fees.captureFee(amountMinor, merchant.feeBps ?: 0)
            val feesId = if (fee > 0) accounts.system(SystemRole.FEES, hold.currency).id else null
            val locks = balances.lock(listOfNotNull(hold.accountId, merchant.id, feesId))
            val wallet = locks[hold.accountId].account
            val lines = buildList {
                add(PostingLine(wallet.id, -amountMinor, hold.currency))
                add(PostingLine(merchant.id, amountMinor - fee, hold.currency))
                if (feesId != null) add(PostingLine(feesId, fee, hold.currency))
            }
            val entry = ledger.post(
                NewEntry(EntryKind.CAPTURE, lines, caller.keyId),
                locks = locks,
                heldDeltas = mapOf(wallet.id to -hold.amountMinor)
            )
            val remainder = hold.amountMinor - amountMinor
            if (remainder > 0) limits.giveBack(wallet.ownerId!!, hold.currency, now.utcDate(), remainder)

            val captured = hold.copy(status = HoldStatus.CAPTURED, capturedMinor = amountMinor, captureEntryId = entry.id)
            record(captured, HOLD_CAPTURED, now)
        }
    }

    /** Releases an active hold, expired or not, and returns it. */
    fun release(caller: Caller, id: UUID): Hold {
        caller.require(Role.SERVICE, Role.MERCHANT, Role.OPERATOR)
        return tx.inTx {
            val hold = holds.lock(id) ?: throw holdNotFound(id)
            requireVisible(caller, hold)
            if (hold.status != HoldStatus.ACTIVE) throw holdNotActive(hold)
            close(hold, HoldStatus.RELEASED, clock.instant())
        }
    }

    /** Expires the hold if it is due at [now]; returns whether it did. */
    fun expire(id: UUID, now: Instant): Boolean =
        tx.inTx {
            val hold = holds.lock(id)
            if (hold == null || !hold.isDue(now)) {
                false
            } else {
                close(hold, HoldStatus.EXPIRED, now)
                true
            }
        }

    /** Takes the whole hold off the wallet's held amount and the owner's usage, and stores it with [status]. */
    private fun close(hold: Hold, status: HoldStatus, now: Instant): Hold {
        val locked = balances.lock(listOf(hold.accountId))[hold.accountId]
        val balance = balances.apply(hold.accountId, 0, -hold.amountMinor, locked.balance.availableMinor)
        events.balanceChanged(locked.account, balance, CauseType.HOLD, hold.id, now)
        limits.giveBack(locked.account.ownerId!!, hold.currency, hold.authorizedOn, hold.amountMinor)
        return record(hold.copy(status = status), if (status == HoldStatus.EXPIRED) HOLD_EXPIRED else HOLD_RELEASED, now)
    }

    /** Stores [changed] with the next version and records [eventType] for it. */
    private fun record(changed: Hold, eventType: String, now: Instant): Hold {
        val stored = changed.copy(version = changed.version + 1, updatedAt = now)
        holds.update(stored)
        events.hold(eventType, stored, now)
        return stored
    }

    private fun requireCapturable(hold: Hold, now: Instant) {
        if (hold.status != HoldStatus.ACTIVE) throw holdNotActive(hold)
        if (hold.isDue(now)) {
            throw ConflictException("hold_expired", "Hold ${hold.id} has expired.", mapOf("expiresAt" to hold.expiresAt))
        }
    }

    private fun requireActive(account: Account) {
        when (account.status) {
            AccountStatus.CLOSED -> throw Errors.accountClosed(account.id)
            AccountStatus.FROZEN -> throw Errors.accountFrozen(account.id)
            AccountStatus.ACTIVE -> Unit
        }
    }

    /** Merchant keys see holds in favour of their own merchant accounts. */
    private fun requireVisible(caller: Caller, hold: Hold) {
        if (!caller.isMerchant) return
        val merchant = accounts.get(hold.merchantAccountId)
        if (merchant.ownerId != caller.ownerId) throw holdNotFound(hold.id)
    }

    private fun holdNotFound(id: UUID) = NotFoundException("Hold $id was not found.")

    private fun holdNotActive(hold: Hold) =
        ConflictException("hold_not_active", "Hold ${hold.id} is ${hold.status.wire}.", mapOf("status" to hold.status))

    companion object {
        const val HOLD_AUTHORIZED = "hold.authorized"
        const val HOLD_CAPTURED = "hold.captured"
        const val HOLD_RELEASED = "hold.released"
        const val HOLD_EXPIRED = "hold.expired"
    }
}
