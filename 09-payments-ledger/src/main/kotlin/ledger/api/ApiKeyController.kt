package ledger.api

import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import ledger.domain.Caller
import ledger.domain.Role
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.time.Instant
import java.util.UUID

data class CreateApiKeyRequest(
    @field:NotBlank
    @field:Size(max = 100)
    val name: String,
    val role: Role,
    val ownerId: UUID? = null
)

/** The response to key creation; [key] is the secret and is shown only here. */
data class CreatedApiKeyResponse(
    val id: UUID,
    val name: String,
    val role: Role,
    val ownerId: UUID?,
    val createdAt: Instant,
    val key: String
)

@RestController
@RequestMapping("/v1/api-keys")
class ApiKeyController(private val apiKeys: ApiKeyService) {
    @PostMapping
    fun create(caller: Caller, @Valid @RequestBody body: CreateApiKeyRequest): ResponseEntity<CreatedApiKeyResponse> {
        val created = apiKeys.create(caller, body.name.trim(), body.role, body.ownerId)
        val key = created.apiKey
        return ResponseEntity.status(HttpStatus.CREATED)
            .body(CreatedApiKeyResponse(key.id, key.name, key.role, key.ownerId, key.createdAt, created.secret))
    }

    @DeleteMapping("/{id}")
    fun revoke(caller: Caller, @PathVariable id: UUID): ResponseEntity<Void> {
        apiKeys.revoke(caller, id)
        return ResponseEntity.noContent().build()
    }
}
