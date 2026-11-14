package ledger.domain

/** A cursor-paged list request: rows after [after], at most [limit] of them. */
data class PageRequest(val after: String?, val limit: Int) {
    companion object {
        const val DEFAULT_LIMIT = 50
        const val MAX_LIMIT = 200

        /** Validates the raw query values and returns a page request. */
        fun of(after: String?, limit: Int?): PageRequest {
            val size = limit ?: DEFAULT_LIMIT
            if (size < 1 || size > MAX_LIMIT) throw validationFailed("limit", "must be between 1 and $MAX_LIMIT")
            if (after != null && after.isBlank()) throw validationFailed("after", "must not be blank")
            return PageRequest(after, size)
        }
    }
}

/** One page of a list, with the cursor for the next page when more rows exist. */
data class Page<T>(val items: List<T>, val nextCursor: String?) {
    companion object {
        /** Builds a page from up to `limit + 1` fetched rows. */
        fun <T> fromFetched(rows: List<T>, limit: Int, cursorOf: (T) -> String): Page<T> {
            val items = rows.take(limit)
            val next = if (rows.size > limit && items.isNotEmpty()) cursorOf(items.last()) else null
            return Page(items, next)
        }
    }
}
