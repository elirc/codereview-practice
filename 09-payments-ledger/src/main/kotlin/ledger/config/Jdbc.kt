package ledger.config

import org.postgresql.util.PSQLException
import java.sql.ResultSet
import java.sql.SQLException
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID

fun ResultSet.uuid(column: String): UUID = getObject(column, UUID::class.java)

fun ResultSet.uuidOrNull(column: String): UUID? = getObject(column, UUID::class.java)

fun ResultSet.instant(column: String): Instant = getObject(column, OffsetDateTime::class.java).toInstant()

fun ResultSet.instantOrNull(column: String): Instant? = getObject(column, OffsetDateTime::class.java)?.toInstant()

fun ResultSet.localDate(column: String): LocalDate = getObject(column, LocalDate::class.java)

fun ResultSet.longOrNull(column: String): Long? {
    val value = getLong(column)
    return if (wasNull()) null else value
}

fun ResultSet.intOrNull(column: String): Int? {
    val value = getInt(column)
    return if (wasNull()) null else value
}

fun ResultSet.booleanOrNull(column: String): Boolean? {
    val value = getBoolean(column)
    return if (wasNull()) null else value
}

/** Converts an instant to the type the PostgreSQL driver binds to `timestamptz`. */
fun Instant.toDb(): OffsetDateTime = atOffset(ZoneOffset.UTC)

/** Reads PostgreSQL error details from exceptions raised by the driver. */
object PgErrors {
    /** Returns the name of the constraint behind [e], if the database reported one. */
    fun constraintName(e: Throwable): String? =
        generateSequence(e) { it.cause }.filterIsInstance<PSQLException>().firstOrNull()?.serverErrorMessage?.constraint

    /** Returns the SQLSTATE behind [e], if any. */
    fun sqlState(e: Throwable): String? =
        generateSequence(e) { it.cause }.filterIsInstance<SQLException>().firstOrNull()?.sqlState

    fun isConstraint(e: Throwable, constraint: String): Boolean = constraintName(e) == constraint
}
