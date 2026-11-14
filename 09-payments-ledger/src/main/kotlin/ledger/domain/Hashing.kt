package ledger.domain

import java.security.MessageDigest
import java.util.HexFormat

object Hashing {
    /** Returns the lower-case hex SHA-256 digest of [bytes]. */
    fun sha256Hex(bytes: ByteArray): String = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))

    /** Returns the lower-case hex SHA-256 digest of the UTF-8 encoding of [text]. */
    fun sha256Hex(text: String): String = sha256Hex(text.toByteArray(Charsets.UTF_8))
}
