package ledger.support

import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.testcontainers.service.connection.ServiceConnection
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Primary
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.utility.DockerImageName
import java.time.Instant

/** Postgres container and the test clock shared by the integration tests. */
@TestConfiguration(proxyBeanMethods = false)
class TestInfrastructure {
    @Bean
    @ServiceConnection
    fun postgresContainer(): PostgreSQLContainer<*> = PostgreSQLContainer(DockerImageName.parse("postgres:16-alpine"))

    @Bean
    @Primary
    fun mutableClock(): MutableClock = MutableClock(START)

    companion object {
        val START: Instant = Instant.parse("2026-03-02T10:00:00Z")
    }
}
