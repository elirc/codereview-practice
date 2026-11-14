package ledger.outbox

import java.util.UUID

/** An unpublished outbox row as handed to a publisher. */
data class OutboxRecord(
    val id: Long,
    val eventId: UUID,
    val topic: String,
    val key: String,
    val eventType: String,
    val payload: String
)

/** Delivers one event to the broker, returning only after the broker has acknowledged it. */
fun interface EventPublisher {
    fun publish(record: OutboxRecord)
}
