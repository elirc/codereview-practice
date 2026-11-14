package ledger.outbox

import com.fasterxml.jackson.databind.ObjectMapper
import ledger.config.IdSource
import ledger.config.RequestIds
import ledger.config.toDb
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import java.time.Instant
import java.util.UUID

/** The envelope every published event carries. */
data class EventEnvelope(
    val id: UUID,
    val type: String,
    val schemaVersion: Int,
    val occurredAt: Instant,
    val aggregateType: String,
    val aggregateId: String,
    val sequence: Long,
    val requestId: String,
    val data: Map<String, Any?>
)

object Topics {
    const val ENTRIES = "ledger.entries"
    const val ACCOUNTS = "ledger.accounts"
    const val SETTLEMENT = "ledger.settlement"

    val ALL = listOf(ENTRIES, ACCOUNTS, SETTLEMENT)
}

/** Writes events to the outbox table in the caller's transaction. */
@Component
class OutboxWriter(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
    private val ids: IdSource
) {
    /** Records one event and returns its envelope. */
    fun record(
        topic: String,
        partitionKey: String,
        type: String,
        aggregateType: String,
        aggregateId: String,
        sequence: Long,
        occurredAt: Instant,
        data: Map<String, Any?>
    ): EventEnvelope {
        val envelope = EventEnvelope(
            id = ids.uuid(),
            type = type,
            schemaVersion = SCHEMA_VERSION,
            occurredAt = occurredAt,
            aggregateType = aggregateType,
            aggregateId = aggregateId,
            sequence = sequence,
            requestId = RequestIds.current(),
            data = data
        )
        jdbc.sql(
            """
            INSERT INTO outbox (event_id, topic, partition_key, payload, created_at)
            VALUES (:eventId, :topic, :partitionKey, CAST(:payload AS jsonb), :createdAt)
            """.trimIndent()
        )
            .param("eventId", envelope.id)
            .param("topic", topic)
            .param("partitionKey", partitionKey)
            .param("payload", mapper.writeValueAsString(envelope))
            .param("createdAt", occurredAt.toDb())
            .update()
        return envelope
    }

    private companion object {
        const val SCHEMA_VERSION = 1
    }
}
