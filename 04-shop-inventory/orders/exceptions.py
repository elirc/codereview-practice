from rest_framework import status

from core.errors import DomainError


class UnknownProduct(DomainError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    code = "unknown_product"
    message = "One or more products do not exist or are not for sale."


class InsufficientStock(DomainError):
    status_code = status.HTTP_409_CONFLICT
    code = "insufficient_stock"
    message = "Not enough stock is available for one or more lines."


class PaymentProviderUnavailable(DomainError):
    status_code = status.HTTP_502_BAD_GATEWAY
    code = "payment_provider_unavailable"
    message = "The payment provider could not be reached. Please try again."
