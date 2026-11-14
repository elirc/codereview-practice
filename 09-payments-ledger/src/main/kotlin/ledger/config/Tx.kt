package ledger.config

import org.springframework.stereotype.Component
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.TransactionStatus
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate

/** The single entry point for database transactions. */
@Component
class Tx(transactionManager: PlatformTransactionManager) {
    private val readCommitted = TransactionTemplate(transactionManager).apply {
        isolationLevel = TransactionDefinition.ISOLATION_READ_COMMITTED
    }
    private val snapshot = TransactionTemplate(transactionManager).apply {
        isolationLevel = TransactionDefinition.ISOLATION_REPEATABLE_READ
        isReadOnly = true
    }

    /** Runs [block] in a READ COMMITTED transaction, or inside the current transaction when one is active. */
    fun <T> inTx(block: () -> T): T {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            return block()
        }
        return run(readCommitted) { block() }
    }

    /** Runs [block] in a READ COMMITTED transaction and hands it the transaction status. */
    fun <T> inTxWithStatus(block: (TransactionStatus) -> T): T = run(readCommitted, block)

    /** Runs [block] in a read-only REPEATABLE READ transaction. */
    fun <T> readSnapshot(block: () -> T): T = run(snapshot) { block() }

    private fun <T> run(template: TransactionTemplate, block: (TransactionStatus) -> T): T {
        @Suppress("UNCHECKED_CAST")
        return template.execute { status -> block(status) } as T
    }
}
