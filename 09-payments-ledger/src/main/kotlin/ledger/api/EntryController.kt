package ledger.api

import com.fasterxml.jackson.databind.JsonNode
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import ledger.domain.Caller
import ledger.idempotency.ApiResult
import ledger.ledger.EntryService
import ledger.ledger.JournalEntry
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

data class ReverseEntryRequest(
    @field:NotBlank
    @field:Size(min = 1, max = 200)
    val reason: String
)

@RestController
@RequestMapping("/v1/entries")
class EntryController(
    private val entries: EntryService,
    private val idempotent: IdempotentRequests
) {
    @GetMapping("/{id}")
    fun get(caller: Caller, @PathVariable id: UUID): JournalEntry = entries.get(caller, id)

    @PostMapping("/{id}/reverse")
    fun reverse(
        caller: Caller,
        @PathVariable id: UUID,
        @Valid @RequestBody body: ReverseEntryRequest,
        request: HttpServletRequest
    ): ResponseEntity<JsonNode> = idempotent.run(caller, request, body) {
        ApiResult(HttpStatus.CREATED.value(), entries.reverse(caller, id, body.reason))
    }
}
