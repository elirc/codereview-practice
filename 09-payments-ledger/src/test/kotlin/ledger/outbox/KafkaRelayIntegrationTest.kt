package ledger.outbox

import com.fasterxml.jackson.databind.ObjectMapper
import ledger.config.Tx
import ledger.support.KafkaTestInfrastructure
import ledger.support.TestInfrastructure
import org.apache.kafka.clients.admin.AdminClient
import org.apache.kafka.clients.admin.AdminClientConfig
import org.apache.kafka.clients.admin.NewTopic
import org.apache.kafka.clients.consumer.ConsumerConfig
import org.apache.kafka.clients.consumer.ConsumerRecord
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.test.context.ActiveProfiles
import org.testcontainers.kafka.KafkaContainer
import java.time.Duration
import java.time.Instant
import java.util.UUID
import kotlin.test.assertEquals

@SpringBootTest
@ActiveProfiles("test")
@Import(TestInfrastructure::class, KafkaTestInfrastructure::class)
class KafkaRelayIntegrationTest {
    @Autowired
    private lateinit var kafkaTemplate: KafkaTemplate<String, String>

    @Autowired
    private lateinit var kafka: KafkaContainer

    @Autowired
    private lateinit var outbox: OutboxWriter

    @Autowired
    private lateinit var tx: Tx

    @Autowired
    private lateinit var jdbc: JdbcClient

    @Autowired
    private lateinit var mapper: ObjectMapper

    @Test
    fun `published records carry the partition key, event headers and the envelope`() {
        AdminClient.create(mapOf<String, Any>(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG to kafka.bootstrapServers)).use { admin ->
            admin.createTopics(listOf(NewTopic(Topics.ACCOUNTS, 6, 1.toShort()))).all().get()
        }
        val accountId = UUID.randomUUID()
        val occurredAt = Instant.parse("2026-03-02T10:00:00Z")
        val envelopes = tx.inTx {
            (1L..3L).map { version ->
                outbox.record(
                    topic = Topics.ACCOUNTS,
                    partitionKey = accountId.toString(),
                    type = "account.balance_changed",
                    aggregateType = "account",
                    aggregateId = accountId.toString(),
                    sequence = version,
                    occurredAt = occurredAt,
                    data = mapOf("accountId" to accountId, "postedMinor" to version * 100)
                )
            }
        }

        val relay = OutboxRelay(tx, jdbc, KafkaEventPublisher(kafkaTemplate))
        assertEquals(3, relay.runOnce(occurredAt).published)

        val received = consume(Topics.ACCOUNTS, 3)
        assertEquals(List(3) { accountId.toString() }, received.map { it.key() })
        assertEquals(envelopes.map { it.id.toString() }, received.map { String(it.headers().lastHeader("eventId").value()) })
        assertEquals(List(3) { "account.balance_changed" }, received.map { String(it.headers().lastHeader("eventType").value()) })
        val bodies = received.map { mapper.readTree(it.value()) }
        assertEquals(listOf(1L, 2L, 3L), bodies.map { it.path("sequence").asLong() })
        assertEquals(envelopes.map { it.id.toString() }, bodies.map { it.path("id").asText() })
        assertEquals("account", bodies.first().path("aggregateType").asText())
        assertEquals(200, bodies[1].path("data").path("postedMinor").asLong())
    }

    private fun consume(topic: String, expected: Int): List<ConsumerRecord<String, String>> {
        val properties = mapOf<String, Any>(
            ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG to kafka.bootstrapServers,
            ConsumerConfig.GROUP_ID_CONFIG to "test-${UUID.randomUUID()}",
            ConsumerConfig.AUTO_OFFSET_RESET_CONFIG to "earliest",
            ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG to StringDeserializer::class.java,
            ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG to StringDeserializer::class.java
        )
        val records = mutableListOf<ConsumerRecord<String, String>>()
        KafkaConsumer<String, String>(properties).use { consumer ->
            consumer.subscribe(listOf(topic))
            val deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos()
            while (records.size < expected && System.nanoTime() < deadline) {
                consumer.poll(Duration.ofMillis(500)).forEach { records += it }
            }
        }
        return records
    }
}
