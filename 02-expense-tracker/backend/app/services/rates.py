import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import ColumnElement, and_, select
from sqlalchemy.exc import IntegrityError

from app.domain.enums import Role
from app.domain.errors import Conflict, InvalidInput, NotFound
from app.models import Currency, ExchangeRate, ExpenseLine
from app.schemas.money import rate_text
from app.schemas.rates import RateCreate, RateOut, RateUpdate
from app.services import audit
from app.services.access import ensure_role
from app.services.context import ServiceContext

RATE_AUDIT_FIELDS = ("from_currency", "effective_date", "rate")
RATE_DECIMAL_PLACES = 10
MAX_RATE = Decimal(10) ** 10


def _referenced_by_frozen_line(currency: Any, effective_date: Any) -> ColumnElement[bool]:
    """EXISTS condition: a frozen line used the rate for (currency, effective_date)."""
    return (
        select(ExpenseLine.id)
        .where(
            and_(
                ExpenseLine.currency == currency,
                ExpenseLine.rate_effective_date == effective_date,
                ExpenseLine.rate_used.is_not(None),
            )
        )
        .exists()
    )


def _rate_out(rate: ExchangeRate, in_use: bool) -> RateOut:
    return RateOut(
        id=rate.id,
        from_currency=rate.from_currency,
        effective_date=rate.effective_date,
        rate=rate_text(rate.rate),
        in_use=in_use,
        created_by=rate.created_by,
        created_at=rate.created_at,
        updated_at=rate.updated_at,
    )


def _is_in_use(ctx: ServiceContext, rate: ExchangeRate) -> bool:
    return bool(
        ctx.db.scalar(select(_referenced_by_frozen_line(rate.from_currency, rate.effective_date)))
    )


def list_rates(
    ctx: ServiceContext, *, from_currency: str | None, limit: int, offset: int
) -> list[RateOut]:
    ensure_role(ctx.actor, Role.FINANCE, Role.ADMIN)
    in_use = _referenced_by_frozen_line(ExchangeRate.from_currency, ExchangeRate.effective_date)
    stmt = select(ExchangeRate, in_use.label("in_use"))
    if from_currency is not None:
        stmt = stmt.where(ExchangeRate.from_currency == from_currency)
    stmt = (
        stmt.order_by(ExchangeRate.from_currency, ExchangeRate.effective_date.desc())
        .limit(limit)
        .offset(offset)
    )
    return [_rate_out(rate, bool(used)) for rate, used in ctx.db.execute(stmt)]


def _base_per_unit(rate: Decimal, inverse: bool) -> Decimal:
    """Express a quote as base-currency units per one unit of the foreign currency."""
    if not inverse:
        return rate
    value = Decimal(str(round(1 / float(rate), RATE_DECIMAL_PLACES)))
    if not 0 < value < MAX_RATE:
        raise InvalidInput.field("rate", "The inverted rate is out of range.")
    return value


def _validate_currency(ctx: ServiceContext, code: str) -> None:
    if ctx.db.get(Currency, code) is None:
        raise InvalidInput.field("from_currency", "Unknown currency.")
    if code == ctx.base_currency:
        raise InvalidInput.field("from_currency", "The base currency does not need a rate.")


def _flush_unique(ctx: ServiceContext) -> None:
    try:
        ctx.db.flush()
    except IntegrityError as exc:
        ctx.db.rollback()
        if "uq_exchange_rates_currency_date" in str(exc.orig):
            raise Conflict(
                "rate_exists", "A rate for this currency and date already exists."
            ) from None
        raise


def create_rate(ctx: ServiceContext, data: RateCreate) -> RateOut:
    ensure_role(ctx.actor, Role.FINANCE, Role.ADMIN)
    _validate_currency(ctx, data.from_currency)
    rate = ExchangeRate(
        id=uuid.uuid4(),
        from_currency=data.from_currency,
        effective_date=data.effective_date,
        rate=_base_per_unit(data.rate, data.inverse),
        created_by=ctx.actor.id,
        created_at=ctx.now,
        updated_at=ctx.now,
    )
    ctx.db.add(rate)
    _flush_unique(ctx)
    audit.record(
        ctx,
        entity_type="rate",
        entity_id=rate.id,
        action="rate.created",
        after=audit.snapshot(rate, RATE_AUDIT_FIELDS),
    )
    ctx.db.commit()
    return _rate_out(rate, in_use=False)


def _editable_rate(ctx: ServiceContext, rate_id: uuid.UUID) -> ExchangeRate:
    """Load a rate that no submitted line has used yet."""
    rate = ctx.db.get(ExchangeRate, rate_id)
    if rate is None:
        raise NotFound()
    if _is_in_use(ctx, rate):
        raise Conflict("rate_in_use", "This rate has been used by a submitted report.")
    ctx.db.refresh(rate, with_for_update=True)
    return rate


def update_rate(ctx: ServiceContext, rate_id: uuid.UUID, data: RateUpdate) -> RateOut:
    ensure_role(ctx.actor, Role.FINANCE, Role.ADMIN)
    rate = _editable_rate(ctx, rate_id)

    before = audit.snapshot(rate, RATE_AUDIT_FIELDS)
    if data.rate is not None:
        rate.rate = _base_per_unit(data.rate, data.inverse)
    if data.effective_date is not None:
        rate.effective_date = data.effective_date
    rate.updated_at = ctx.now
    _flush_unique(ctx)

    old, new = audit.changed_fields(before, audit.snapshot(rate, RATE_AUDIT_FIELDS))
    if new:
        audit.record(
            ctx,
            entity_type="rate",
            entity_id=rate.id,
            action="rate.updated",
            before=old,
            after=new,
        )
    ctx.db.commit()
    return _rate_out(rate, in_use=False)
