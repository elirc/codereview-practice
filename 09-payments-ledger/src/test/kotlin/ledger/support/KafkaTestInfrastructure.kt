package ledger.support

import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.testcontainers.service.connection.ServiceConnection
import org.springframework.context.annotation.Bean
import org.testcontainers.kafka.KafkaContainer
import org.testcontainers.utility.DockerImageName

/** A Kafka broker for the tests that read published events back. */
@TestConfiguration(proxyBeanMethods = false)
class KafkaTestInfrastructure {
    @Bean
    @ServiceConnection
    fun kafkaContainer(): KafkaContainer = KafkaContainer(DockerImageName.parse("apache/kafka:3.9.0"))
}
