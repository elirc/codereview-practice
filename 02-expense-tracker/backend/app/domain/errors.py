from typing import Any


class DomainError(Exception):
    """Base class for errors that carry a stable, client-facing code.

    Subclasses describe the category of failure; the API layer maps each
    category to an HTTP status in one place.
    """

    default_code = "domain_error"
    default_message = "The request could not be completed."

    def __init__(
        self,
        code: str | None = None,
        message: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.code = code or self.default_code
        self.message = message or self.default_message
        self.details = details or {}
        super().__init__(self.message)


class InvalidInput(DomainError):
    default_code = "validation_failed"
    default_message = "The request is invalid."

    @classmethod
    def field(cls, path: str, message: str) -> "InvalidInput":
        return cls(details={"fields": [{"path": path, "message": message}]})


class Unauthenticated(DomainError):
    default_code = "unauthenticated"
    default_message = "Authentication is required."


class Forbidden(DomainError):
    default_code = "forbidden"
    default_message = "You are not allowed to perform this action."


class NotFound(DomainError):
    default_code = "not_found"
    default_message = "The requested resource was not found."


class Conflict(DomainError):
    default_code = "conflict"
    default_message = "The request conflicts with the current state."


class InvalidTransition(Conflict):
    default_code = "invalid_state"
    default_message = "This action is not allowed in the report's current state."


class RuleViolation(DomainError):
    default_code = "rule_violation"
    default_message = "The request breaks a business rule."


class PayloadTooLarge(DomainError):
    default_code = "file_too_large"
    default_message = "The uploaded file is too large."


class UnsupportedMediaType(DomainError):
    default_code = "unsupported_media_type"
    default_message = "The uploaded content type is not supported."
