package ledger.seed

import ledger.config.Tx
import ledger.domain.AccountType
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.domain.EntryKind
import ledger.domain.Hashing
import ledger.domain.PostingLine
import ledger.domain.Role
import ledger.domain.SystemRole
import ledger.fx.FxService
import ledger.holds.AuthorizeCommand
import ledger.holds.HoldService
import ledger.ledger.AccountService
import ledger.ledger.Accounts
import ledger.ledger.CreateAccountCommand
import ledger.ledger.LedgerService
import ledger.ledger.NewEntry
import ledger.limits.LimitService
import ledger.transfers.TransferCommand
import ledger.transfers.TransferService
import org.slf4j.LoggerFactory
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.boot.SpringApplication
import org.springframework.context.ApplicationContext
import org.springframework.context.annotation.Profile
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import java.math.BigDecimal
import java.util.UUID
import kotlin.system.exitProcess

/** Creates a small, repeatable development dataset and exits. Running it again changes nothing. */
@Component
@Profile("seed")
class SeedCommand(
    private val context: ApplicationContext,
    private val tx: Tx,
    private val jdbc: JdbcClient,
    private val accounts: Accounts,
    private val accountService: AccountService,
    private val ledger: LedgerService,
    private val transfers: TransferService,
    private val holds: HoldService,
    private val fx: FxService,
    private val limits: LimitService
) : ApplicationRunner {
    private val log = LoggerFactory.getLogger(javaClass)

    override fun run(args: ApplicationArguments) {
        seed()
        log.info("Seed data is in place")
        exitProcess(SpringApplication.exit(context))
    }

    private fun seed() {
        SEED_KEYS.forEach { key -> insertKey(key) }
        val operator = Caller(OPERATOR_KEY_ID, Role.OPERATOR, null)
        val service = Caller(SERVICE_KEY_ID, Role.SERVICE, null)

        val firstRun = accounts.list(ALICE, null, 10).isEmpty()
        val aliceUsd = ensureAccount(operator, ALICE, AccountType.CUSTOMER_WALLET, Currency.USD)
        val aliceEur = ensureAccount(operator, ALICE, AccountType.CUSTOMER_WALLET, Currency.EUR)
        val bobUsd = ensureAccount(operator, BOB, AccountType.CUSTOMER_WALLET, Currency.USD)
        val bobJpy = ensureAccount(operator, BOB, AccountType.CUSTOMER_WALLET, Currency.JPY)
        val shopUsd = ensureAccount(operator, SHOP_OWNER, AccountType.MERCHANT, Currency.USD, feeBps = 250)
        ensureAccount(operator, SHOP_OWNER, AccountType.MERCHANT, Currency.EUR, feeBps = 150)
        if (!firstRun) return

        deposit(aliceUsd, 250_000, Currency.USD)
        deposit(aliceEur, 80_000, Currency.EUR)
        deposit(bobUsd, 120_000, Currency.USD)
        deposit(bobJpy, 1_500_000, Currency.JPY)
        limits.setLimit(operator, BOB, Currency.USD, 300_000)
        fx.publishRate(operator, Currency.USD, Currency.EUR, BigDecimal("0.92150000"), 40)
        fx.publishRate(operator, Currency.USD, Currency.JPY, BigDecimal("151.23456789"), 50)
        fx.publishRate(operator, Currency.EUR, Currency.USD, BigDecimal("1.08400000"), 40)
        transfers.transfer(service, TransferCommand(aliceUsd, bobUsd, 15_000, Currency.USD))
        transfers.transfer(service, TransferCommand(bobUsd, shopUsd, 4_500, Currency.USD))
        holds.authorize(service, AuthorizeCommand(aliceUsd, shopUsd, 6_000, Currency.USD, 86_400))
    }

    private fun insertKey(key: SeedKey) {
        jdbc.sql(
            """
            INSERT INTO api_keys (id, name, key_hash, role, owner_id, created_at)
            VALUES (:id, :name, :hash, :role, :ownerId, now())
            ON CONFLICT (id) DO NOTHING
            """.trimIndent()
        )
            .param("id", key.id)
            .param("name", key.name)
            .param("hash", Hashing.sha256Hex(key.secret))
            .param("role", key.role.wire)
            .param("ownerId", key.ownerId)
            .update()
    }

    private fun ensureAccount(operator: Caller, owner: UUID, type: AccountType, currency: Currency, feeBps: Int? = null): UUID {
        val existing = accounts.list(owner, null, 50).firstOrNull { it.type == type && it.currency == currency }
        if (existing != null) return existing.id
        val payoutEnabled = if (type == AccountType.MERCHANT) true else null
        return accountService.create(operator, CreateAccountCommand(owner, type, currency, feeBps, payoutEnabled)).id
    }

    private fun deposit(accountId: UUID, amountMinor: Long, currency: Currency) {
        tx.inTx {
            ledger.post(
                NewEntry(
                    kind = EntryKind.DEPOSIT,
                    lines = listOf(
                        PostingLine(accounts.system(SystemRole.BANK_CASH, currency).id, -amountMinor, currency),
                        PostingLine(accountId, amountMinor, currency)
                    ),
                    actorKeyId = OPERATOR_KEY_ID
                )
            )
        }
    }

    private data class SeedKey(val id: UUID, val name: String, val role: Role, val ownerId: UUID?, val secret: String)

    private companion object {
        val ALICE: UUID = UUID.fromString("a11ce000-0000-4000-8000-000000000001")
        val BOB: UUID = UUID.fromString("b0b00000-0000-4000-8000-000000000002")
        val SHOP_OWNER: UUID = UUID.fromString("5a0b0000-0000-4000-8000-000000000003")
        val OPERATOR_KEY_ID: UUID = UUID.fromString("00000000-0000-4000-8000-0000000000a1")
        val SERVICE_KEY_ID: UUID = UUID.fromString("00000000-0000-4000-8000-0000000000a2")

        val SEED_KEYS = listOf(
            SeedKey(OPERATOR_KEY_ID, "seed operator", Role.OPERATOR, null, "lk_dev_operator_9f3c1e7a5b2d4f608e1a3c5b7d9f0e2a"),
            SeedKey(SERVICE_KEY_ID, "seed service", Role.SERVICE, null, "lk_dev_service_2b4d6f8a0c1e3a5b7d9f1e3c5a7b9d0f"),
            SeedKey(
                UUID.fromString("00000000-0000-4000-8000-0000000000a3"),
                "seed auditor",
                Role.AUDITOR,
                null,
                "lk_dev_auditor_7e9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e"
            ),
            SeedKey(
                UUID.fromString("00000000-0000-4000-8000-0000000000a4"),
                "seed merchant",
                Role.MERCHANT,
                SHOP_OWNER,
                "lk_dev_merchant_4c6e8a0b2d4f6a8c0e2b4d6f8a0c2e4b"
            )
        )
    }
}
