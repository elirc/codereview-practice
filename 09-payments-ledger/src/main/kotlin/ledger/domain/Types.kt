package ledger.domain

import com.fasterxml.jackson.annotation.JsonValue

/** An enum persisted and exchanged as a lower-case string. */
interface WireValue {
    val wire: String
}

/** Returns the [E] constant whose wire value is [value]. */
inline fun <reified E> wireValueOf(value: String): E where E : Enum<E>, E : WireValue =
    enumValues<E>().firstOrNull { it.wire == value }
        ?: throw IllegalArgumentException("unknown ${E::class.simpleName} value '$value'")

enum class AccountType(@get:JsonValue override val wire: String) : WireValue {
    CUSTOMER_WALLET("customer_wallet"),
    MERCHANT("merchant"),
    SYSTEM("system")
}

enum class AccountStatus(@get:JsonValue override val wire: String) : WireValue {
    ACTIVE("active"),
    FROZEN("frozen"),
    CLOSED("closed")
}

enum class SystemRole(@get:JsonValue override val wire: String) : WireValue {
    BANK_CASH("bank_cash"),
    PAYOUT_CLEARING("payout_clearing"),
    FX_POSITION("fx_position"),
    FX_RESIDUE("fx_residue"),
    FEES("fees"),
    SUSPENSE("suspense")
}

enum class EntryKind(@get:JsonValue override val wire: String) : WireValue {
    DEPOSIT("deposit"),
    WITHDRAWAL("withdrawal"),
    TRANSFER("transfer"),
    CAPTURE("capture"),
    FX_TRANSFER("fx_transfer"),
    SETTLEMENT("settlement"),
    BANK_MATCH("bank_match"),
    PAYOUT_RETURN("payout_return"),
    SUSPENSE("suspense"),
    REVERSAL("reversal")
}

enum class Role(@get:JsonValue override val wire: String) : WireValue {
    SERVICE("service"),
    MERCHANT("merchant"),
    OPERATOR("operator"),
    AUDITOR("auditor")
}
