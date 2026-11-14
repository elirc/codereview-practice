package ledger.ledger

import ledger.domain.Caller
import ledger.domain.NotFoundException
import ledger.domain.Role
import org.springframework.stereotype.Service
import java.util.UUID

/** Reads journal entries. */
@Service
class EntryService(private val entries: EntryQueries) {
    /** Returns the entry with its postings. */
    fun get(caller: Caller, id: UUID): JournalEntry {
        caller.require(Role.OPERATOR, Role.AUDITOR)
        return entries.find(id) ?: throw NotFoundException("Entry $id was not found.")
    }
}
