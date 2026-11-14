package ledger.config

import ledger.outbox.EventPublisher
import ledger.outbox.KafkaEventPublisher
import ledger.outbox.OutboxRelay
import ledger.outbox.OutboxRelayLoop
import ledger.outbox.Topics
import org.apache.kafka.clients.admin.NewTopic
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.kafka.config.TopicBuilder
import org.springframework.kafka.core.KafkaTemplate

/** Kafka topics, the Kafka publisher and the outbox relay of the worker process. */
@Configuration
@Profile("worker")
class WorkerConfiguration {
    @Bean
    fun entriesTopic(): NewTopic = topic(Topics.ENTRIES)

    @Bean
    fun accountsTopic(): NewTopic = topic(Topics.ACCOUNTS)

    @Bean
    fun settlementTopic(): NewTopic = topic(Topics.SETTLEMENT)

    @Bean
    fun eventPublisher(kafkaTemplate: KafkaTemplate<String, String>): EventPublisher = KafkaEventPublisher(kafkaTemplate)

    @Bean
    fun outboxRelay(tx: Tx, jdbc: JdbcClient, eventPublisher: EventPublisher): OutboxRelay = OutboxRelay(tx, jdbc, eventPublisher)

    @Bean
    fun outboxRelayLoop(outboxRelay: OutboxRelay): OutboxRelayLoop = OutboxRelayLoop(outboxRelay)

    private fun topic(name: String): NewTopic = TopicBuilder.name(name).partitions(PARTITIONS).replicas(1).build()

    private companion object {
        const val PARTITIONS = 6
    }
}
