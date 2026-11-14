package ledger.ledger

import ledger.domain.AccountStatus
import ledger.domain.BusinessRuleException
import ledger.domain.Currency
import ledger.domain.EntryKind
import ledger.domain.InvalidEntryException
import ledger.domain.PostingLine
import ledger.domain.SystemRole
import ledger.support.IntegrationTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.springframework.beans.factory.annotation.Autowired
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertTrue

class PostingIntegrationTest : IntegrationTest() {
    @Autowired
    private lateinit var entryQueries: EntryQueries

    private fun transfer(from: UUID, to: UUID, amount: Long, kind: EntryKind = EntryKind.TRANSFER): JournalEntry =
        tx.inTx {
            ledger.post(
                NewEntry(
                    kind = kind,
                    lines = listOf(PostingLine(from, -amount, Currency.USD), PostingLine(to, amount, Currency.USD)),
                    actorKeyId = serviceKey.id
                )
            )
        }

    private fun rootMessages(e: Throwable): String = generateSequence(e) { it.cause }.joinToString(" | ") { it.message ?: "" }

    @Test
    fun `transfer moves the amount and bumps both balance versions`() {
        val a = wallet()
        val b = wallet()
        fund(a, 10_000)

        val entry = transfer(a, b, 2_500)

        assertEquals(7_500, balance(a).postedMinor)
        assertEquals(2, balance(a).version)
        assertEquals(2_500, balance(b).postedMinor)
        assertEquals(1, balance(b).version)
        assertEquals(listOf(1, 2), entry.postings.map { it.lineNo })
        assertEquals(entry, entryQueries.find(entry.id))
    }

    @Test
    fun `entry that would overdraw a wallet is refused and changes nothing`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)

        val error = assertThrows<BusinessRuleException> { transfer(a, b, 1_001) }

        assertEquals("insufficient_funds", error.code)
        assertEquals(1_000L, error.details["availableMinor"])
        assertEquals(1_000, balance(a).postedMinor)
        assertEquals(0, balance(b).postedMinor)
        assertEquals(1, entryCount())
    }

    @Test
    fun `system accounts may go negative`() {
        val a = wallet()
        fund(a, 5_000)
        assertEquals(-5_000, balance(systemAccount(SystemRole.BANK_CASH)).postedMinor)
    }

    @Test
    fun `unbalanced entry is refused before anything is written`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        assertThrows<InvalidEntryException> {
            tx.inTx {
                ledger.post(
                    NewEntry(
                        EntryKind.TRANSFER,
                        listOf(PostingLine(a, -100, Currency.USD), PostingLine(b, 90, Currency.USD)),
                        serviceKey.id
                    )
                )
            }
        }
        assertEquals(1, entryCount())
    }

    @Test
    fun `database refuses an unbalanced entry at commit`() {
        val a = wallet()
        val b = wallet()
        val error = assertFails {
            tx.inTx {
                val id = UUID.randomUUID()
                jdbc.sql("INSERT INTO journal_entries (id, kind, request_id, created_at) VALUES (:id, 'transfer', 't', now())")
                    .param("id", id).update()
                jdbc.sql("INSERT INTO postings VALUES (:id, 1, :a, -100, 'USD')").param("id", id).param("a", a).update()
                jdbc.sql("INSERT INTO postings VALUES (:id, 2, :b, 50, 'USD')").param("id", id).param("b", b).update()
            }
        }
        assertTrue(rootMessages(error).contains("does not balance"), rootMessages(error))
        assertEquals(0, entryCount())
    }

    @Test
    fun `database refuses an entry with a single posting`() {
        val a = wallet()
        val error = assertFails {
            tx.inTx {
                val id = UUID.randomUUID()
                jdbc.sql("INSERT INTO journal_entries (id, kind, request_id, created_at) VALUES (:id, 'transfer', 't', now())")
                    .param("id", id).update()
                jdbc.sql("INSERT INTO postings VALUES (:id, 1, :a, 100, 'USD')").param("id", id).param("a", a).update()
            }
        }
        assertTrue(rootMessages(error).contains("at least two"), rootMessages(error))
    }

    @Test
    fun `database refuses a posting in a currency other than the account's`() {
        val a = wallet(currency = Currency.EUR)
        val b = wallet(currency = Currency.EUR)
        val error = assertFails {
            tx.inTx {
                val id = UUID.randomUUID()
                jdbc.sql("INSERT INTO journal_entries (id, kind, request_id, created_at) VALUES (:id, 'transfer', 't', now())")
                    .param("id", id).update()
                jdbc.sql("INSERT INTO postings VALUES (:id, 1, :a, -100, 'USD')").param("id", id).param("a", a).update()
                jdbc.sql("INSERT INTO postings VALUES (:id, 2, :b, 100, 'USD')").param("id", id).param("b", b).update()
            }
        }
        assertTrue(rootMessages(error).contains("does not match account"), rootMessages(error))
    }

    @Test
    fun `journal rows cannot be updated or deleted`() {
        val a = wallet()
        val entry = fund(a, 1_000)

        val update = assertFails {
            jdbc.sql("UPDATE journal_entries SET reason = 'edited' WHERE id = :id").param("id", entry.id).update()
        }
        assertTrue(rootMessages(update).contains("cannot be updated or deleted"))
        val delete = assertFails {
            jdbc.sql("DELETE FROM postings WHERE entry_id = :id").param("id", entry.id).update()
        }
        assertTrue(rootMessages(delete).contains("cannot be updated or deleted"))
        val amend = assertFails {
            jdbc.sql("UPDATE postings SET amount_minor = 1 WHERE entry_id = :id").param("id", entry.id).update()
        }
        assertTrue(rootMessages(amend).contains("cannot be updated or deleted"))
    }

    @Test
    fun `balance check constraint backs up the available rule`() {
        val a = wallet()
        fund(a, 100)
        val error = assertFails {
            jdbc.sql("UPDATE account_balances SET posted_minor = -1 WHERE account_id = :id").param("id", a).update()
        }
        assertTrue(rootMessages(error).contains("account_balances_available_check"))
    }

    @Test
    fun `closed accounts accept nothing and frozen accounts accept only credits`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)

        accounts.updateStatus(b, AccountStatus.FROZEN)
        transfer(a, b, 100)
        assertEquals("account_frozen", assertThrows<BusinessRuleException> { transfer(b, a, 50) }.code)
        transfer(b, a, 50, EntryKind.CAPTURE)
        assertEquals(50, balance(b).postedMinor)

        accounts.updateStatus(b, AccountStatus.CLOSED)
        assertEquals("account_closed", assertThrows<BusinessRuleException> { transfer(a, b, 10) }.code)
    }

    @Test
    fun `posting records one entry event and one balance event per account`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        val entry = transfer(a, b, 400)

        assertEquals(2, outboxCount("entry.posted"))
        assertEquals(3, outboxCount("account.balance_changed"))
        val payload = jdbc.sql(
            "SELECT payload::text FROM outbox WHERE payload ->> 'type' = 'account.balance_changed' AND partition_key = :key ORDER BY id DESC LIMIT 1"
        ).param("key", a.toString()).query(String::class.java).single()
        val node = mapper.readTree(payload)
        assertEquals(2, node.path("sequence").asLong())
        assertEquals(600, node.path("data").path("postedMinor").asLong())
        assertEquals(entry.id.toString(), node.path("data").path("causeId").asText())
        assertEquals("entry", node.path("data").path("causeType").asText())
    }

    @Test
    fun `outbox rows disappear with a rolled back posting`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        assertFails {
            tx.inTx {
                transfer(a, b, 300)
                throw IllegalStateException("abort")
            }
        }
        assertEquals(1, outboxCount("entry.posted"))
        assertEquals(1_000, balance(a).postedMinor)
    }
}
