from decimal import Decimal
from typing import Annotated, Any

from pydantic import BeforeValidator, Field, Strict, StringConstraints

from app.schemas.common import MAX_BIGINT

CurrencyCode = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]
AmountMinor = Annotated[int, Strict(), Field(gt=0, le=MAX_BIGINT)]


def _require_decimal_string(value: Any) -> Any:
    if not isinstance(value, str):
        raise ValueError("must be a decimal string, for example \"1.0825\"")
    return value


RateValue = Annotated[
    Decimal,
    BeforeValidator(_require_decimal_string),
    Field(gt=0, lt=Decimal(10) ** 10, max_digits=20, decimal_places=10),
]


def rate_text(rate: Decimal) -> str:
    """Render a rate as plain decimal text without trailing zeros."""
    text = format(rate, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text
