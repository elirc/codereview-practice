from rest_framework import status

from core.errors import DomainError


class ExceedsRefundable(DomainError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    code = "exceeds_refundable"
    message = "The refund is larger than the amount that can still be refunded."


class ExceedsRefundableQuantity(DomainError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    code = "exceeds_refundable_quantity"
    message = "One or more lines have fewer refundable units than requested."


class InvalidLine(DomainError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    code = "invalid_line"
    message = "One or more lines do not belong to this order."


class RefundLimitExceeded(DomainError):
    status_code = status.HTTP_403_FORBIDDEN
    code = "refund_limit_exceeded"
    message = "This refund is above the limit you are allowed to issue."


class OrderNotFoundYet(Exception):
    """No order carries the event's payment intent (yet); processing should be retried."""


class InvalidEventData(Exception):
    """The event's ``data`` object does not have the fields its type requires."""
