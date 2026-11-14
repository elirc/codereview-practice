package ledger.domain

import java.util.UUID

/** The authenticated API key behind a request. Merchant keys carry the owner they act for. */
data class Caller(val keyId: UUID, val role: Role, val ownerId: UUID?) {
    /** Throws [ForbiddenException] unless the caller has one of [allowed]. */
    fun require(vararg allowed: Role) {
        if (role !in allowed) throw ForbiddenException()
    }

    val isMerchant: Boolean get() = role == Role.MERCHANT
}
