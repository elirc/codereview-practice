"""Domain errors and the single place that turns exceptions into the JSON error envelope."""

from typing import Any

import structlog
from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.http import Http404
from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.settings import api_settings

logger = structlog.get_logger(__name__)


class DomainError(Exception):
    """Base for errors that carry a stable code and map to a client-facing response."""

    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    code = "business_rule_violation"
    message = "The request breaks a business rule."

    def __init__(self, message: str | None = None, *, details: dict[str, Any] | None = None):
        self.message = message or type(self).message
        self.details = details or {}
        super().__init__(self.message)


class NotFound(DomainError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "not_found"
    message = "The requested resource was not found."


class InvalidState(DomainError):
    status_code = status.HTTP_409_CONFLICT
    code = "invalid_state"
    message = "The resource is not in a state that allows this action."


class ValidationFailed(DomainError):
    status_code = status.HTTP_400_BAD_REQUEST
    code = "validation_failed"
    message = "The request is invalid."

    def __init__(self, fields: list[dict[str, str]], message: str | None = None):
        super().__init__(message, details={"fields": fields})


_API_CODES: dict[type[exceptions.APIException], str] = {
    exceptions.NotAuthenticated: "not_authenticated",
    exceptions.AuthenticationFailed: "not_authenticated",
    exceptions.PermissionDenied: "forbidden",
    exceptions.NotFound: "not_found",
    exceptions.MethodNotAllowed: "method_not_allowed",
    exceptions.ParseError: "malformed_request",
    exceptions.UnsupportedMediaType: "unsupported_media_type",
    exceptions.NotAcceptable: "not_acceptable",
    exceptions.Throttled: "rate_limited",
}


def current_request_id() -> str | None:
    return structlog.contextvars.get_contextvars().get("request_id")


def envelope(
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
    request_id: str | None = None,
) -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "details": details or {},
            "requestId": request_id,
        }
    }


def domain_error_body(exc: DomainError, request_id: str | None) -> dict[str, Any]:
    return envelope(exc.code, exc.message, exc.details, request_id)


def flatten_errors(detail: Any, path: str = "") -> list[dict[str, str]]:
    """Turn DRF's nested error structure into a flat list of ``{path, message}`` entries."""
    if isinstance(detail, dict):
        fields: list[dict[str, str]] = []
        for key, value in detail.items():
            if key == api_settings.NON_FIELD_ERRORS_KEY:
                child = path
            else:
                child = f"{path}.{key}" if path else str(key)
            fields.extend(flatten_errors(value, child))
        return fields
    if isinstance(detail, list):
        if all(not isinstance(item, dict | list) for item in detail):
            return [{"path": path, "message": str(item)} for item in detail]
        fields = []
        for index, item in enumerate(detail):
            fields.extend(flatten_errors(item, f"{path}.{index}" if path else str(index)))
        return fields
    return [{"path": path, "message": str(detail)}]


def exception_handler(exc: Exception, context: dict[str, Any]) -> Response:
    """DRF exception handler producing the error envelope for every failure."""
    request_id = current_request_id()

    if isinstance(exc, DomainError):
        return Response(domain_error_body(exc, request_id), status=exc.status_code)

    if isinstance(exc, Http404):
        exc = exceptions.NotFound()
    elif isinstance(exc, DjangoPermissionDenied):
        exc = exceptions.PermissionDenied()

    if isinstance(exc, exceptions.ValidationError):
        body = envelope(
            "validation_failed",
            "The request is invalid.",
            {"fields": flatten_errors(exc.detail)},
            request_id,
        )
        return Response(body, status=status.HTTP_400_BAD_REQUEST)

    if isinstance(exc, exceptions.APIException):
        code = _API_CODES.get(type(exc), exc.default_code)
        message = exc.detail if isinstance(exc.detail, str) else str(exc.default_detail)
        response = Response(envelope(code, str(message), None, request_id), status=exc.status_code)
        auth_header = getattr(exc, "auth_header", None)
        if auth_header:
            response["WWW-Authenticate"] = auth_header
        wait = getattr(exc, "wait", None)
        if wait is not None:
            response["Retry-After"] = str(int(wait))
        return response

    view = context.get("view")
    logger.error(
        "unhandled_exception",
        view=type(view).__name__ if view is not None else None,
        exc_info=exc,
    )
    body = envelope("internal_error", "An unexpected error occurred.", None, request_id)
    return Response(body, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
