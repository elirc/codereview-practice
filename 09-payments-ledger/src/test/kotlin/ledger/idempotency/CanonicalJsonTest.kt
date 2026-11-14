package ledger.idempotency

import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class CanonicalJsonTest {
    private val mapper = ObjectMapper()

    private fun canonical(json: String): String = CanonicalJson.write(mapper.readTree(json))

    @Test
    fun `sorts keys at every level and drops whitespace`() {
        assertEquals(
            """{"a":[3,{"x":true,"y":null}],"b":{"c":"d","e":1}}""",
            canonical("""{ "b": { "e": 1, "c": "d" },  "a": [3, {"y": null, "x": true}] }""")
        )
    }

    @Test
    fun `keeps array order and escapes strings`() {
        assertEquals("""["z","a","q\"uote"]""", canonical("""[ "z", "a", "q\"uote" ]"""))
    }

    @Test
    fun `equal documents written differently share a fingerprint`() {
        val first = RequestFingerprint.of("POST", "/v1/transfers", canonical("""{"amountMinor":100,"currency":"USD"}"""))
        val second = RequestFingerprint.of("post", "/v1/transfers", canonical("""{ "currency" : "USD", "amountMinor" : 100 }"""))
        assertEquals(first, second)
        assertEquals(64, first.length)
    }

    @Test
    fun `fingerprint changes with path, method or body`() {
        val body = canonical("""{"amountMinor":100}""")
        val base = RequestFingerprint.of("POST", "/v1/holds/a/capture", body)
        assertNotEquals(base, RequestFingerprint.of("POST", "/v1/holds/b/capture", body))
        assertNotEquals(base, RequestFingerprint.of("PUT", "/v1/holds/a/capture", body))
        assertNotEquals(base, RequestFingerprint.of("POST", "/v1/holds/a/capture", canonical("""{"amountMinor":101}""")))
    }
}
