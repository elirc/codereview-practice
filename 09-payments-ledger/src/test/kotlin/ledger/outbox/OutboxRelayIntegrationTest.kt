package ledger.outbox

import ledger.jobs.OutboxPurgeJob
import ledger.support.IntegrationTest
import ledger.support.RecordingPublisher
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.time.Duration
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OutboxRelayIntegrationTest : IntegrationTest() {
    @Autowired
    private lateinit var purgeJob: OutboxPurgeJob

    private fun unpublished(): Long =
        jdbc.sql("SELECT count(*) FROM outbox WHERE published_at IS NULL").query(Long::class.javaObjectType).single()

    private fun outboxIds(): List<Long> = jdbc.sql("SELECT id FROM outbox ORDER BY id").query(Long::class.javaObjectType).list()

    private fun transfer(from: UUID, to: UUID, amount: Long) {
        val result = post(
            "/v1/transfers",
            serviceKey,
            mapOf("fromAccountId" to from, "toAccountId" to to, "amountMinor" to amount, "currency" to "USD")
        )
        assertEquals(201, result.response.status, result.response.contentAsString)
    }

    @Test
    fun `relay publishes every row in id order and marks them`() {
        val a = wallet()
        val b = wallet()
        fund(a, 1_000)
        transfer(a, b, 100)
        val publisher = RecordingPublisher()
        val relay = OutboxRelay(tx, jdbc, publisher)

        val result = relay.runOnce(clock.instant())

        assertEquals(6, result.published)
        assertFalse(result.failed)
        assertEquals(outboxIds(), publisher.records().map { it.id })
        assertEquals(0, unpublished())
        assertEquals(0, relay.runOnce(clock.instant()).published)
        val first = publisher.records().first()
        assertEquals("entry.posted", first.eventType)
        assertEquals("ledger.entries", first.topic)
        val envelope = mapper.readTree(first.payload)
        assertEquals(first.eventId.toString(), envelope.path("id").asText())
        assertEquals(1, envelope.path("schemaVersion").asInt())
        assertEquals("2026-03-02T10:00:00Z", envelope.path("occurredAt").asText())
    }

    @Test
    fun `a failed publish stops the pass and later rows wait behind it`() {
        val a = wallet()
        fund(a, 1_000)
        fund(a, 2_000)
        val ids = outboxIds()
        val publisher = RecordingPublisher()
        publisher.failWhen = { it.id == ids[3] }
        val relay = OutboxRelay(tx, jdbc, publisher)

        val failed = relay.runOnce(clock.instant())

        assertTrue(failed.failed)
        assertEquals(3, failed.published)
        assertEquals(3, unpublished())
        val error = jdbc.sql("SELECT attempts, last_error FROM outbox WHERE id = :id")
            .param("id", ids[3])
            .query { rs, _ -> rs.getInt("attempts") to rs.getString("last_error") }
            .single()
        assertEquals(1, error.first)
        assertEquals("broker unavailable", error.second)

        relay.runOnce(clock.instant())
        assertEquals(3, unpublished())

        publisher.failWhen = { false }
        val resumed = relay.runOnce(clock.instant())
        assertEquals(3, resumed.published)
        assertEquals(ids, publisher.records().map { it.id })
    }

    @Test
    fun `api writes succeed while the broker is down and are published in order afterwards`() {
        val a = wallet()
        val b = wallet()
        fund(a, 10_000)
        val publisher = RecordingPublisher()
        publisher.failWhen = { true }
        val relay = OutboxRelay(tx, jdbc, publisher)
        relay.runOnce(clock.instant())

        repeat(5) { transfer(a, b, 100) }
        relay.runOnce(clock.instant())
        assertEquals(outboxIds().size.toLong(), unpublished())

        val stats = json(get("/v1/outbox/stats", operatorKey))
        assertEquals(unpublished(), stats.path("unpublishedCount").asLong())

        publisher.failWhen = { false }
        relay.runOnce(clock.instant())
        assertEquals(outboxIds(), publisher.records().map { it.id })
        assertEquals(0, unpublished())
    }

    @Test
    fun `rows are sent again with the same event id when marking does not commit`() {
        val a = wallet()
        fund(a, 500)
        val publisher = RecordingPublisher()
        val relay = OutboxRelay(tx, jdbc, publisher)

        tx.inTxWithStatus { status ->
            relay.runOnce(clock.instant())
            status.setRollbackOnly()
        }
        assertEquals(3, unpublished())
        relay.runOnce(clock.instant())

        val sent = publisher.records()
        assertEquals(6, sent.size)
        assertEquals(sent.take(3).map { it.eventId }, sent.drop(3).map { it.eventId })
        assertEquals(0, unpublished())
    }

    @Test
    fun `two relays together keep per account order and send each row once`() {
        val a = wallet()
        val b = wallet()
        fund(a, 10_000)
        fund(b, 10_000)
        repeat(10) { i -> if (i % 2 == 0) transfer(a, b, 10L + i) else transfer(b, a, 10L + i) }
        val publisher = RecordingPublisher()
        val relays = listOf(OutboxRelay(tx, jdbc, publisher, batchSize = 4), OutboxRelay(tx, jdbc, publisher, batchSize = 4))

        simultaneously(2) { index ->
            while (unpublished() > 0) relays[index].runOnce(clock.instant())
        }

        val records = publisher.records()
        assertEquals(outboxIds().size, records.size)
        assertEquals(records.size, records.map { it.eventId }.toSet().size)
        listOf(a, b).forEach { account ->
            val sequences = records
                .filter { it.key == account.toString() && it.eventType == "account.balance_changed" }
                .map { mapper.readTree(it.payload).path("sequence").asLong() }
            assertEquals(sequences.sorted(), sequences)
            assertEquals(sequences.size, sequences.toSet().size)
            assertEquals(11, sequences.size)
        }
    }

    @Test
    fun `stats report the backlog to operators only`() {
        val empty = json(get("/v1/outbox/stats", operatorKey))
        assertEquals(0, empty.path("unpublishedCount").asLong())
        assertTrue(empty.path("oldestUnpublishedAgeSeconds").isNull)

        fund(wallet(), 100)
        clock.advance(Duration.ofSeconds(90))
        val stats = json(get("/v1/outbox/stats", operatorKey))
        assertEquals(3, stats.path("unpublishedCount").asLong())
        assertEquals(90, stats.path("oldestUnpublishedAgeSeconds").asLong())
        assertEquals(403, get("/v1/outbox/stats", auditorKey).response.status)
    }

    @Test
    fun `purge deletes rows published longer ago than the retention`() {
        val a = wallet()
        fund(a, 100)
        val relay = OutboxRelay(tx, jdbc, RecordingPublisher())
        relay.runOnce(clock.instant())
        clock.advance(Duration.ofHours(1))
        fund(a, 100)
        relay.runOnce(clock.instant())
        fund(a, 100)

        assertEquals(0, purgeJob.runOnce(clock.instant().plus(Duration.ofHours(71))))
        assertEquals(3, purgeJob.runOnce(clock.instant().plus(Duration.ofHours(72)).minusSeconds(3_599)))
        assertEquals(6, outboxIds().size)
        assertEquals(3, unpublished())
    }
}
