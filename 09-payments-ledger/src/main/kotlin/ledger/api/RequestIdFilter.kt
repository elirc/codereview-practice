package ledger.api

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import ledger.config.IdSource
import ledger.config.RequestIds
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter

/** Binds a request id to every request: the inbound `X-Request-Id` when well formed, otherwise a new one. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
class RequestIdFilter(private val ids: IdSource) : OncePerRequestFilter() {
    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, filterChain: FilterChain) {
        val inbound = request.getHeader(RequestIds.HEADER)
        val requestId = if (inbound != null && VALID_ID.matches(inbound)) inbound else ids.uuid().toString()
        response.setHeader(RequestIds.HEADER, requestId)
        RequestIds.withRequestId(requestId) {
            filterChain.doFilter(request, response)
        }
    }

    private companion object {
        val VALID_ID = Regex("^[A-Za-z0-9._:-]{1,128}$")
    }
}
