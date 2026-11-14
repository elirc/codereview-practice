package ledger.support

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import ledger.config.Tx
import ledger.domain.AccountType
import ledger.domain.Caller
import ledger.domain.Currency
import ledger.domain.EntryKind
import ledger.domain.Hashing
import ledger.domain.PostingLine
import ledger.domain.Role
import ledger.domain.SystemRole
import ledger.ledger.AccountService
import ledger.ledger.Accounts
import ledger.ledger.BalanceRow
import ledger.ledger.BalanceStore
import ledger.ledger.CreateAccountCommand
import ledger.ledger.JournalEntry
import ledger.ledger.LedgerService
import ledger.ledger.NewEntry
import org.junit.jupiter.api.BeforeEach
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.http.MediaType
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.test.context.ActiveProfiles
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.MvcResult
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** An API key created for a test, with its secret and the caller it authenticates as. */
data class TestKey(val id: UUID, val secret: String, val caller: Caller)

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(TestInfrastructure::class)
abstract class IntegrationTest {
    @Autowired
    protected lateinit var mvc: MockMvc

    @Autowired
    protected lateinit var jdbc: JdbcClient

    @Autowired
    protected lateinit var mapper: ObjectMapper

    @Autowired
    protected lateinit var clock: MutableClock

    @Autowired
    protected lateinit var tx: Tx

    @Autowired
    protected lateinit var ledger: LedgerService

    @Autowired
    protected lateinit var accounts: Accounts

    @Autowired
    protected lateinit var balances: BalanceStore

    @Autowired
    protected lateinit var accountService: AccountService

    protected lateinit var operatorKey: TestKey
    protected lateinit var serviceKey: TestKey
    protected lateinit var auditorKey: TestKey

    @BeforeEach
    fun resetState() {
        resetDatabase()
        clock.set(TestInfrastructure.START)
        operatorKey = newKey(Role.OPERATOR)
        serviceKey = newKey(Role.SERVICE)
        auditorKey = newKey(Role.AUDITOR)
    }

    private fun resetDatabase() {
        val tables = jdbc.sql(
            """
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public'
              AND tablename NOT IN ('flyway_schema_history', 'accounts', 'account_balances')
            """.trimIndent()
        ).query(String::class.java).list()
        if (tables.isNotEmpty()) {
            jdbc.sql("TRUNCATE ${tables.joinToString(", ")} RESTART IDENTITY CASCADE").update()
        }
        jdbc.sql("DELETE FROM account_balances WHERE account_id IN (SELECT id FROM accounts WHERE type <> 'system')").update()
        jdbc.sql("DELETE FROM accounts WHERE type <> 'system'").update()
        jdbc.sql("UPDATE account_balances SET posted_minor = 0, held_minor = 0, version = 0").update()
    }

    protected fun newKey(role: Role, ownerId: UUID? = null): TestKey {
        val id = UUID.randomUUID()
        val secret = "test_${UUID.randomUUID()}_${UUID.randomUUID()}"
        jdbc.sql(
            """
            INSERT INTO api_keys (id, name, key_hash, role, owner_id, created_at)
            VALUES (:id, :name, :hash, :role, :ownerId, now())
            """.trimIndent()
        )
            .param("id", id)
            .param("name", "test ${role.wire}")
            .param("hash", Hashing.sha256Hex(secret))
            .param("role", role.wire)
            .param("ownerId", ownerId)
            .update()
        return TestKey(id, secret, Caller(id, role, ownerId))
    }

    protected fun wallet(owner: UUID = UUID.randomUUID(), currency: Currency = Currency.USD): UUID =
        accountService.create(
            operatorKey.caller,
            CreateAccountCommand(owner, AccountType.CUSTOMER_WALLET, currency, null, null)
        ).id

    protected fun merchant(
        owner: UUID = UUID.randomUUID(),
        currency: Currency = Currency.USD,
        feeBps: Int = 0,
        payoutEnabled: Boolean = true
    ): UUID = accountService.create(
        operatorKey.caller,
        CreateAccountCommand(owner, AccountType.MERCHANT, currency, feeBps, payoutEnabled)
    ).id

    protected fun systemAccount(role: SystemRole, currency: Currency = Currency.USD): UUID = accounts.system(role, currency).id

    /** Credits [amountMinor] to an account from the bank cash account of its currency. */
    protected fun fund(accountId: UUID, amountMinor: Long): JournalEntry {
        val currency = accounts.get(accountId).currency
        return tx.inTx {
            ledger.post(
                NewEntry(
                    kind = EntryKind.DEPOSIT,
                    lines = listOf(
                        PostingLine(systemAccount(SystemRole.BANK_CASH, currency), -amountMinor, currency),
                        PostingLine(accountId, amountMinor, currency)
                    ),
                    actorKeyId = null
                )
            )
        }
    }

    protected fun balance(accountId: UUID): BalanceRow = balances.read(accountId)!!

    protected fun ownerOf(accountId: UUID): UUID = accounts.get(accountId).ownerId!!

    protected fun at(instant: String) {
        clock.set(Instant.parse(instant))
    }

    protected fun post(
        path: String,
        key: TestKey,
        body: Any? = null,
        idempotencyKey: String? = UUID.randomUUID().toString()
    ): MvcResult {
        val request = MockMvcRequestBuilders.post(path).auth(key)
        if (idempotencyKey != null) request.header("Idempotency-Key", idempotencyKey)
        if (body != null) {
            request.contentType(MediaType.APPLICATION_JSON).content(body as? String ?: mapper.writeValueAsString(body))
        }
        return mvc.perform(request).andReturn()
    }

    /** Uploads a statement file as `text/csv`. */
    protected fun upload(
        bankAccountCode: String,
        csv: String,
        key: TestKey = operatorKey,
        idempotencyKey: String = UUID.randomUUID().toString()
    ): MvcResult =
        mvc.perform(
            MockMvcRequestBuilders.post("/v1/statements?bankAccountCode=$bankAccountCode").auth(key)
                .header("Idempotency-Key", idempotencyKey)
                .contentType("text/csv")
                .content(csv.toByteArray(Charsets.UTF_8))
        ).andReturn()

    protected fun put(path: String, key: TestKey, body: Any): MvcResult =
        mvc.perform(
            MockMvcRequestBuilders.put(path).auth(key)
                .contentType(MediaType.APPLICATION_JSON)
                .content(body as? String ?: mapper.writeValueAsString(body))
        ).andReturn()

    protected fun get(path: String, key: TestKey): MvcResult = mvc.perform(MockMvcRequestBuilders.get(path).auth(key)).andReturn()

    protected fun delete(path: String, key: TestKey): MvcResult =
        mvc.perform(MockMvcRequestBuilders.delete(path).auth(key)).andReturn()

    protected fun json(result: MvcResult): JsonNode = mapper.readTree(result.response.contentAsString)

    protected fun errorCode(result: MvcResult): String = json(result).path("error").path("code").asText()

    protected fun outboxCount(type: String): Long =
        jdbc.sql("SELECT count(*) FROM outbox WHERE payload ->> 'type' = :type")
            .param("type", type)
            .query(Long::class.javaObjectType)
            .single()

    protected fun entryCount(): Long = jdbc.sql("SELECT count(*) FROM journal_entries").query(Long::class.javaObjectType).single()

    /** Runs [task] on [threads] threads released at the same moment and returns the results in thread order. */
    protected fun <T> simultaneously(threads: Int, task: (Int) -> T): List<T> {
        val pool = Executors.newFixedThreadPool(threads)
        val ready = CountDownLatch(threads)
        val go = CountDownLatch(1)
        try {
            val futures = (0 until threads).map { index ->
                pool.submit(
                    Callable {
                        ready.countDown()
                        go.await()
                        task(index)
                    }
                )
            }
            ready.await(10, TimeUnit.SECONDS)
            go.countDown()
            return futures.map { it.get(60, TimeUnit.SECONDS) }
        } finally {
            pool.shutdownNow()
        }
    }

    private fun MockHttpServletRequestBuilder.auth(key: TestKey): MockHttpServletRequestBuilder =
        header("Authorization", "Bearer ${key.secret}")
}
