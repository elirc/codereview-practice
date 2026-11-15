package ledger.fx

import ledger.config.IdSource
import ledger.config.LedgerProperties
import ledger.config.Tx
import ledger.config.instant
import ledger.config.toDb
import ledger.config.uuid
import ledger.config.uuidOrNull
import ledger.domain.BusinessRuleException
import ledger.domain.Caller
import ledger.domain.ConflictException
import ledger.domain.Currency
import ledger.domain.EntryKind
import ledger.domain.Errors
import ledger.domain.FxAmounts
import ledger.domain.FxMath
import ledger.domain.NotFoundException
import ledger.domain.PostingLine
import ledger.domain.Role
import ledger.domain.SystemRole
import ledger.domain.validationFailed
import ledger.ledger.Accounts
import ledger.ledger.JournalEntry
import ledger.ledger.LedgerService
import ledger.ledger.NewEntry
import ledger.ledger.requireCustomerFacing
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import java.math.BigDecimal
import java.time.Clock
import java.time.Instant
import java.util.UUID

data class FxRate(
    val id: UUID,
    val sellCurrency: Currency,
    val buyCurrency: Currency,
    val midRate: BigDecimal,
    val spreadBps: Int,
    val publishedAt: Instant,
    val publishedBy: UUID
)

data class FxQuote(
    val id: UUID,
    val ownerId: UUID,
    val rateId: UUID,
    val sellCurrency: Currency,
    val buyCurrency: Currency,
    val sellMinor: Long,
    val buyMinor: Long,
    val midBuyMinor: Long,
    val midRate: BigDecimal,
    val customerRate: BigDecimal,
    val expiresAt: Instant,
    val createdAt: Instant,
    val usedEntryId: UUID?
)

data class QuoteCommand(
    val ownerId: UUID,
    val sellCurrency: Currency,
    val buyCurrency: Currency,
    val sellAmountMinor: Long?,
    val buyAmountMinor: Long?
)

data class FxTransferCommand(val quoteId: UUID, val fromAccountId: UUID, val toAccountId: UUID)

/** Publishes exchange rates, issues quotes and converts money at a quote. */
@Service
class FxService(
    private val tx: Tx,
    private val jdbc: JdbcClient,
    private val accounts: Accounts,
    private val ledger: LedgerService,
    private val properties: LedgerProperties,
    private val ids: IdSource,
    private val clock: Clock
) {
    /** Appends a rate for the ordered pair and returns it; a rate equal to the pair's current one returns that rate. */
    fun publishRate(caller: Caller, sell: Currency, buy: Currency, midRate: BigDecimal, spreadBps: Int): FxRate {
        caller.require(Role.OPERATOR)
        if (sell == buy) throw validationFailed("buyCurrency", "must differ from sellCurrency")
        if (midRate.signum() <= 0) throw validationFailed("midRate", "must be greater than zero")
        val scaled = midRate.setScale(FxMath.RATE_SCALE)
        return tx.inTx {
            val current = latestRate(sell, buy)
            if (current != null && current.midRate == scaled && current.spreadBps == spreadBps) {
                current
            } else {
                FxRate(ids.uuid(), sell, buy, scaled, spreadBps, clock.instant(), caller.keyId).also { insertRate(it) }
            }
        }
    }

    /** Returns the current rate for the ordered pair. */
    fun currentRate(caller: Caller, sell: Currency, buy: Currency): FxRate {
        caller.require(Role.SERVICE, Role.OPERATOR, Role.AUDITOR)
        return latestRate(sell, buy) ?: throw NotFoundException("No rate has been published for $sell to $buy.")
    }

    /** Prices a conversion at the current rate and stores the quote. */
    fun quote(caller: Caller, command: QuoteCommand): FxQuote {
        caller.require(Role.SERVICE)
        if (command.sellCurrency == command.buyCurrency) throw validationFailed("buyCurrency", "must differ from sellCurrency")
        if ((command.sellAmountMinor == null) == (command.buyAmountMinor == null)) {
            throw validationFailed("sellAmountMinor", "exactly one of sellAmountMinor and buyAmountMinor is required")
        }
        val now = clock.instant()
        val rate = latestRate(command.sellCurrency, command.buyCurrency)
            ?: throw BusinessRuleException(
                "rate_unavailable",
                "No rate is available for ${command.sellCurrency} to ${command.buyCurrency}."
            )
        if (rate.publishedAt.plus(properties.fxRateMaxAge).isBefore(now)) {
            throw BusinessRuleException("rate_stale", "The latest rate is too old to quote.", mapOf("publishedAt" to rate.publishedAt))
        }
        val customerRate = FxMath.customerRate(rate.midRate, rate.spreadBps)
        val amounts = price(command, rate.midRate, customerRate)
        if (amounts.sellMinor <= 0 || amounts.buyMinor <= 0) {
            throw BusinessRuleException("amount_too_small", "The amount is too small to convert at this rate.")
        }
        val quote = FxQuote(
            id = ids.uuid(),
            ownerId = command.ownerId,
            rateId = rate.id,
            sellCurrency = command.sellCurrency,
            buyCurrency = command.buyCurrency,
            sellMinor = amounts.sellMinor,
            buyMinor = amounts.buyMinor,
            midBuyMinor = amounts.midBuyMinor,
            midRate = rate.midRate,
            customerRate = customerRate,
            expiresAt = now.plus(properties.fxQuoteTtl),
            createdAt = now,
            usedEntryId = null
        )
        tx.inTx { insertQuote(quote) }
        return quote
    }

    /** Converts money between two accounts of the quote's owner at the quote's amounts and returns the entry. */
    fun transfer(caller: Caller, command: FxTransferCommand): JournalEntry {
        caller.require(Role.SERVICE)
        return tx.inTx {
            val quote = findQuote(command.quoteId) ?: throw NotFoundException("Quote ${command.quoteId} was not found.")
            val from = accounts.get(command.fromAccountId)
            val to = accounts.get(command.toAccountId)
            requireCustomerFacing(from)
            requireCustomerFacing(to)
            if (from.ownerId != quote.ownerId || to.ownerId != quote.ownerId) {
                throw BusinessRuleException("quote_owner_mismatch", "Both accounts must belong to the quote's owner.")
            }
            if (from.currency != quote.sellCurrency || to.currency != quote.buyCurrency) {
                throw Errors.currencyMismatch(
                    "The account currencies do not match the quote, ${quote.sellCurrency} to ${quote.buyCurrency}."
                )
            }
            if (quote.usedEntryId != null) throw quoteAlreadyUsed(quote.id)
            if (!clock.instant().isBefore(quote.expiresAt)) {
                throw BusinessRuleException("quote_expired", "Quote ${quote.id} has expired.", mapOf("expiresAt" to quote.expiresAt))
            }
            val entryId = ids.uuid()
            val consumed = jdbc.sql("UPDATE fx_quotes SET used_entry_id = :entryId WHERE id = :id AND used_entry_id IS NULL")
                .param("entryId", entryId)
                .param("id", quote.id)
                .update()
            if (consumed == 0) throw quoteAlreadyUsed(quote.id)

            val sell = quote.sellCurrency
            val buy = quote.buyCurrency
            val residue = quote.midBuyMinor - quote.buyMinor
            val lines = buildList {
                add(PostingLine(from.id, -quote.sellMinor, sell))
                add(PostingLine(accounts.system(SystemRole.FX_POSITION, sell).id, quote.sellMinor, sell))
                add(PostingLine(accounts.system(SystemRole.FX_POSITION, buy).id, -quote.midBuyMinor, buy))
                add(PostingLine(to.id, quote.buyMinor, buy))
                if (residue != 0L) add(PostingLine(accounts.system(SystemRole.FX_RESIDUE, buy).id, residue, buy))
            }
            ledger.post(NewEntry(kind = EntryKind.FX_TRANSFER, lines = lines, actorKeyId = caller.keyId, id = entryId))
        }
    }

    private fun price(command: QuoteCommand, midRate: BigDecimal, customerRate: BigDecimal): FxAmounts {
        val sellAmount = command.sellAmountMinor
        return if (sellAmount != null) {
            FxMath.forSellAmount(sellAmount, midRate, customerRate, command.sellCurrency, command.buyCurrency)
        } else {
            if (customerRate.signum() == 0) {
                throw BusinessRuleException("amount_too_small", "The amount is too small to convert at this rate.")
            }
            FxMath.forBuyAmount(command.buyAmountMinor!!, midRate, customerRate, command.sellCurrency, command.buyCurrency)
        }
    }

    private fun quoteAlreadyUsed(id: UUID) = ConflictException("quote_already_used", "Quote $id has already been used.")

    private fun latestRate(sell: Currency, buy: Currency): FxRate? =
        jdbc.sql(
            """
            SELECT * FROM fx_rates
            WHERE sell_currency = :sell AND buy_currency = :buy
            ORDER BY published_at DESC, id DESC
            LIMIT 1
            """.trimIndent()
        )
            .param("sell", sell.name)
            .param("buy", buy.name)
            .query(RATE)
            .optional()
            .orElse(null)

    private fun insertRate(rate: FxRate) {
        jdbc.sql(
            """
            INSERT INTO fx_rates (id, sell_currency, buy_currency, mid_rate, spread_bps, published_at, published_by)
            VALUES (:id, :sell, :buy, :midRate, :spreadBps, :publishedAt, :publishedBy)
            """.trimIndent()
        )
            .param("id", rate.id)
            .param("sell", rate.sellCurrency.name)
            .param("buy", rate.buyCurrency.name)
            .param("midRate", rate.midRate)
            .param("spreadBps", rate.spreadBps)
            .param("publishedAt", rate.publishedAt.toDb())
            .param("publishedBy", rate.publishedBy)
            .update()
    }

    private fun findQuote(id: UUID): FxQuote? =
        jdbc.sql("SELECT * FROM fx_quotes WHERE id = :id")
            .param("id", id)
            .query(QUOTE)
            .optional()
            .orElse(null)

    private fun insertQuote(quote: FxQuote) {
        jdbc.sql(
            """
            INSERT INTO fx_quotes (id, owner_id, rate_id, sell_currency, buy_currency, sell_minor, buy_minor, mid_buy_minor,
                                   mid_rate, customer_rate, expires_at, created_at)
            VALUES (:id, :ownerId, :rateId, :sell, :buy, :sellMinor, :buyMinor, :midBuyMinor,
                    :midRate, :customerRate, :expiresAt, :createdAt)
            """.trimIndent()
        )
            .param("id", quote.id)
            .param("ownerId", quote.ownerId)
            .param("rateId", quote.rateId)
            .param("sell", quote.sellCurrency.name)
            .param("buy", quote.buyCurrency.name)
            .param("sellMinor", quote.sellMinor)
            .param("buyMinor", quote.buyMinor)
            .param("midBuyMinor", quote.midBuyMinor)
            .param("midRate", quote.midRate)
            .param("customerRate", quote.customerRate)
            .param("expiresAt", quote.expiresAt.toDb())
            .param("createdAt", quote.createdAt.toDb())
            .update()
    }

    private companion object {
        val RATE = RowMapper { rs, _ ->
            FxRate(
                id = rs.uuid("id"),
                sellCurrency = Currency.fromDb(rs.getString("sell_currency")),
                buyCurrency = Currency.fromDb(rs.getString("buy_currency")),
                midRate = rs.getBigDecimal("mid_rate"),
                spreadBps = rs.getInt("spread_bps"),
                publishedAt = rs.instant("published_at"),
                publishedBy = rs.uuid("published_by")
            )
        }

        val QUOTE = RowMapper { rs, _ ->
            FxQuote(
                id = rs.uuid("id"),
                ownerId = rs.uuid("owner_id"),
                rateId = rs.uuid("rate_id"),
                sellCurrency = Currency.fromDb(rs.getString("sell_currency")),
                buyCurrency = Currency.fromDb(rs.getString("buy_currency")),
                sellMinor = rs.getLong("sell_minor"),
                buyMinor = rs.getLong("buy_minor"),
                midBuyMinor = rs.getLong("mid_buy_minor"),
                midRate = rs.getBigDecimal("mid_rate"),
                customerRate = rs.getBigDecimal("customer_rate"),
                expiresAt = rs.instant("expires_at"),
                createdAt = rs.instant("created_at"),
                usedEntryId = rs.uuidOrNull("used_entry_id")
            )
        }
    }
}
