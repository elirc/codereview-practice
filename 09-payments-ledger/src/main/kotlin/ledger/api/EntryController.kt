package ledger.api

import ledger.domain.Caller
import ledger.ledger.EntryService
import ledger.ledger.JournalEntry
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

@RestController
@RequestMapping("/v1/entries")
class EntryController(private val entries: EntryService) {
    @GetMapping("/{id}")
    fun get(caller: Caller, @PathVariable id: UUID): JournalEntry = entries.get(caller, id)
}
