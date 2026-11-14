package ledger.outbox

import org.apache.kafka.clients.producer.ProducerRecord
import org.springframework.kafka.core.KafkaTemplate
import java.time.Duration
import java.util.concurrent.TimeUnit

/** Publishes outbox events to Kafka with the partition key as record key and the envelope as value. */
class KafkaEventPublisher(
    private val template: KafkaTemplate<String, String>,
    private val timeout: Duration = Duration.ofSeconds(5)
) : EventPublisher {
    override fun publish(record: OutboxRecord) {
        val producerRecord = ProducerRecord(record.topic, record.key, record.payload)
        producerRecord.headers().add(EVENT_ID_HEADER, record.eventId.toString().toByteArray(Charsets.UTF_8))
        producerRecord.headers().add(EVENT_TYPE_HEADER, record.eventType.toByteArray(Charsets.UTF_8))
        template.send(producerRecord).get(timeout.toMillis(), TimeUnit.MILLISECONDS)
    }

    companion object {
        const val EVENT_ID_HEADER = "eventId"
        const val EVENT_TYPE_HEADER = "eventType"
    }
}
