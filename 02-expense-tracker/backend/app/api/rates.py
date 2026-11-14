import uuid
from typing import Annotated

from fastapi import APIRouter, Query, status
from sqlalchemy import select

from app.api.deps import Ctx, CurrentUser, DbSession, Page
from app.models import Currency
from app.schemas.common import Paginated
from app.schemas.money import CurrencyCode
from app.schemas.rates import CurrencyOut, RateCreate, RateOut, RateUpdate
from app.services import rates as rates_service

router = APIRouter(tags=["exchange-rates"])


@router.get("/currencies")
def list_currencies(_user: CurrentUser, db: DbSession) -> list[CurrencyOut]:
    rows = db.scalars(select(Currency).order_by(Currency.code))
    return [CurrencyOut(code=c.code, exponent=c.exponent) for c in rows]


@router.get("/exchange-rates")
def list_rates(
    ctx: Ctx,
    page: Page,
    from_currency: Annotated[CurrencyCode | None, Query()] = None,
) -> Paginated[RateOut]:
    items = rates_service.list_rates(
        ctx, from_currency=from_currency, limit=page.limit, offset=page.offset
    )
    return Paginated[RateOut](items=items, limit=page.limit, offset=page.offset)


@router.post("/exchange-rates", status_code=status.HTTP_201_CREATED)
def create_rate(ctx: Ctx, body: RateCreate) -> RateOut:
    return rates_service.create_rate(ctx, body)


@router.patch("/exchange-rates/{rate_id}")
def update_rate(ctx: Ctx, rate_id: uuid.UUID, body: RateUpdate) -> RateOut:
    return rates_service.update_rate(ctx, rate_id, body)
