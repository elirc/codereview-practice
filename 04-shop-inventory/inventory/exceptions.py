from rest_framework import status

from core.errors import DomainError


class AdjustmentBelowReserved(DomainError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    code = "adjustment_below_reserved"
    message = "The adjustment would leave fewer units on hand than are reserved."


class UnknownProduct(DomainError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    code = "unknown_product"
    message = "One or more counted SKUs do not exist."
