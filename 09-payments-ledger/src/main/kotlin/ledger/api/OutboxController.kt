package ledger.api

import ledger.domain.Caller
import ledger.outbox.OutboxStats
import ledger.outbox.OutboxStatsService
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/outbox")
class OutboxController(private val outbox: OutboxStatsService) {
    @GetMapping("/stats")
    fun stats(caller: Caller): OutboxStats = outbox.stats(caller)
}
