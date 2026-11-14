import uuid
from datetime import date, datetime

from pydantic import BaseModel, model_validator

from app.schemas.common import StrictModel
from app.schemas.money import CurrencyCode, RateValue


class RateCreate(StrictModel):
    from_currency: CurrencyCode
    effective_date: date
    rate: RateValue


class RateUpdate(StrictModel):
    effective_date: date | None = None
    rate: RateValue | None = None

    @model_validator(mode="after")
    def _non_null_changes(self) -> "RateUpdate":
        if not self.model_fields_set:
            raise ValueError("at least one of effective_date or rate is required")
        for name in self.model_fields_set:
            if getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class RateOut(BaseModel):
    id: uuid.UUID
    from_currency: str
    effective_date: date
    rate: str
    in_use: bool
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class CurrencyOut(BaseModel):
    code: str
    exponent: int
