package ledger.support

import ledger.outbox.EventPublisher
import ledger.outbox.OutboxRecord
import java.util.Collections

/** A publisher that records what it was given and can be told to fail. */
class RecordingPublisher : EventPublisher {
    private val sent: MutableList<OutboxRecord> = Collections.synchronizedList(mutableListOf())

    @Volatile
    var failWhen: (OutboxRecord) -> Boolean = { false }

    override fun publish(record: OutboxRecord) {
        if (failWhen(record)) throw IllegalStateException("broker unavailable")
        sent += record
    }

    fun records(): List<OutboxRecord> = synchronized(sent) { sent.toList() }
}
