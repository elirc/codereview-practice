package ledger.config

import org.springframework.stereotype.Component
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID

/** Generates identifiers, references and secrets. */
@Component
class IdSource(private val random: SecureRandom) {
    fun uuid(): UUID = UUID.randomUUID()

    /** Returns [length] random characters from the RFC 4648 base32 alphabet. */
    fun base32(length: Int): String {
        val chars = CharArray(length) { BASE32[random.nextInt(BASE32.length)] }
        return String(chars)
    }

    /** Returns a new API key secret carrying 256 random bits. */
    fun apiKeySecret(): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return "lk_" + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private companion object {
        const val BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    }
}
