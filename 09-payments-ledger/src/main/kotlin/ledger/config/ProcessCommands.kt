package ledger.config

import org.slf4j.LoggerFactory
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.boot.SpringApplication
import org.springframework.context.ApplicationContext
import org.springframework.context.annotation.Profile
import org.springframework.stereotype.Component
import kotlin.system.exitProcess

/** Exits the `migrate` process once Flyway has applied the migrations during start-up. */
@Component
@Profile("migrate")
class MigrateCommand(private val context: ApplicationContext) : ApplicationRunner {
    private val log = LoggerFactory.getLogger(javaClass)

    override fun run(args: ApplicationArguments) {
        log.info("Database migrations applied")
        exitProcess(SpringApplication.exit(context))
    }
}
