import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Numeric,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

RATE_TYPE = Numeric(20, 10)


class Currency(Base):
    __tablename__ = "currencies"
    __table_args__ = (CheckConstraint("exponent IN (0, 2, 3)", name="exponent_valid"),)

    code: Mapped[str] = mapped_column(String(3), primary_key=True)
    exponent: Mapped[int] = mapped_column(SmallInteger)


class ExchangeRate(Base):
    __tablename__ = "exchange_rates"
    __table_args__ = (
        UniqueConstraint(
            "from_currency", "effective_date", name="uq_exchange_rates_currency_date"
        ),
        CheckConstraint("rate > 0", name="rate_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    from_currency: Mapped[str] = mapped_column(ForeignKey("currencies.code"))
    effective_date: Mapped[date] = mapped_column(Date)
    rate: Mapped[Decimal] = mapped_column(RATE_TYPE)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
