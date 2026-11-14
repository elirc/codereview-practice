package ledger.api

import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import ledger.domain.Caller
import ledger.domain.UnauthenticatedException
import org.springframework.core.MethodParameter
import org.springframework.http.HttpHeaders
import org.springframework.stereotype.Component
import org.springframework.web.bind.support.WebDataBinderFactory
import org.springframework.web.context.request.NativeWebRequest
import org.springframework.web.context.request.RequestAttributes
import org.springframework.web.method.support.HandlerMethodArgumentResolver
import org.springframework.web.method.support.ModelAndViewContainer
import org.springframework.web.servlet.HandlerInterceptor

private const val CALLER_ATTRIBUTE = "ledger.caller"

/** Resolves the `Authorization: Bearer <key>` header of every `/v1` request to a [Caller]. */
@Component
class ApiKeyInterceptor(private val apiKeys: ApiKeyService) : HandlerInterceptor {
    override fun preHandle(request: HttpServletRequest, response: HttpServletResponse, handler: Any): Boolean {
        val header = request.getHeader(HttpHeaders.AUTHORIZATION) ?: throw UnauthenticatedException()
        if (!header.startsWith(BEARER_PREFIX)) throw UnauthenticatedException()
        val secret = header.substring(BEARER_PREFIX.length).trim()
        if (secret.isEmpty()) throw UnauthenticatedException()
        val caller = apiKeys.authenticate(secret) ?: throw UnauthenticatedException()
        request.setAttribute(CALLER_ATTRIBUTE, caller)
        return true
    }

    private companion object {
        const val BEARER_PREFIX = "Bearer "
    }
}

/** Supplies the authenticated [Caller] to controller methods that declare it. */
class CallerArgumentResolver : HandlerMethodArgumentResolver {
    override fun supportsParameter(parameter: MethodParameter): Boolean = parameter.parameterType == Caller::class.java

    override fun resolveArgument(
        parameter: MethodParameter,
        mavContainer: ModelAndViewContainer?,
        webRequest: NativeWebRequest,
        binderFactory: WebDataBinderFactory?
    ): Any = webRequest.getAttribute(CALLER_ATTRIBUTE, RequestAttributes.SCOPE_REQUEST) as? Caller
        ?: throw UnauthenticatedException()
}
