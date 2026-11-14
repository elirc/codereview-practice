from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import get_logger
from app.domain.errors import (
    Conflict,
    DomainError,
    Forbidden,
    InvalidInput,
    NotFound,
    PayloadTooLarge,
    RuleViolation,
    Unauthenticated,
    UnsupportedMediaType,
)

log = get_logger(__name__)

_STATUS_BY_CATEGORY: tuple[tuple[type[DomainError], int], ...] = (
    (InvalidInput, 400),
    (Unauthenticated, 401),
    (Forbidden, 403),
    (NotFound, 404),
    (Conflict, 409),
    (PayloadTooLarge, 413),
    (UnsupportedMediaType, 415),
    (RuleViolation, 422),
)

_HTTP_STATUS_CODES = {
    400: "bad_request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    413: "file_too_large",
    415: "unsupported_media_type",
}


def status_for(error: DomainError) -> int:
    for category, status in _STATUS_BY_CATEGORY:
        if isinstance(error, category):
            return status
    return 500


def request_id_of(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


def error_response(
    request: Request,
    status: int,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> JSONResponse:
    body: dict[str, Any] = {
        "error": {
            "code": code,
            "message": message,
            "details": details or {},
            "request_id": request_id_of(request),
        }
    }
    return JSONResponse(status_code=status, content=body)


async def _domain_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, DomainError)
    status = status_for(exc)
    if status >= 500:
        log.error("unmapped_domain_error", code=exc.code, exc_info=exc)
        return error_response(request, 500, "internal_error", "An unexpected error occurred.")
    return error_response(request, status, exc.code, exc.message, exc.details)


def _field_path(loc: tuple[int | str, ...]) -> str:
    parts = [str(part) for part in loc]
    if parts and parts[0] in {"body", "query", "path", "header", "cookie"}:
        parts = parts[1:]
    return ".".join(parts)


async def _validation_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    fields = [
        {"path": _field_path(tuple(err.get("loc", ()))), "message": str(err.get("msg", ""))}
        for err in exc.errors()
    ]
    return error_response(
        request, 400, "validation_failed", "The request is invalid.", {"fields": fields}
    )


async def _http_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)
    code = _HTTP_STATUS_CODES.get(exc.status_code, "http_error")
    message = exc.detail if isinstance(exc.detail, str) else "The request could not be completed."
    return error_response(request, exc.status_code, code, message)


async def _unexpected_error_handler(request: Request, exc: Exception) -> JSONResponse:
    log.error("unhandled_exception", path=request.url.path, exc_info=exc)
    return error_response(request, 500, "internal_error", "An unexpected error occurred.")


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(DomainError, _domain_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_error_handler)
    app.add_exception_handler(StarletteHTTPException, _http_error_handler)
    app.add_exception_handler(Exception, _unexpected_error_handler)
