package ledger.idempotency

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.TextNode
import ledger.domain.Hashing

/** Writes JSON with object keys sorted and no insignificant whitespace. */
object CanonicalJson {
    fun write(node: JsonNode): String {
        val out = StringBuilder()
        append(node, out)
        return out.toString()
    }

    private fun append(node: JsonNode, out: StringBuilder) {
        when {
            node.isObject -> {
                out.append('{')
                node.fieldNames().asSequence().sorted().forEachIndexed { index, name ->
                    if (index > 0) out.append(',')
                    out.append(TextNode.valueOf(name).toString())
                    out.append(':')
                    append(node.get(name), out)
                }
                out.append('}')
            }
            node.isArray -> {
                out.append('[')
                node.forEachIndexed { index, element ->
                    if (index > 0) out.append(',')
                    append(element, out)
                }
                out.append(']')
            }
            else -> out.append(node.toString())
        }
    }
}

/** Computes the fingerprint that ties an idempotency key to one request. */
object RequestFingerprint {
    /** Returns the hex SHA-256 over the method, the resolved path and the canonical body. */
    fun of(method: String, path: String, canonicalBody: String): String =
        Hashing.sha256Hex("${method.uppercase()}\n$path\n$canonicalBody")
}
