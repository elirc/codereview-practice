import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.conversion import Conversion, RateQuote, convert_line
from app.domain.money import Money
from app.models import Currency, ExchangeRate, ExpenseLine


def currency_exponents(db: Session) -> dict[str, int]:
    return {
        code: exponent for code, exponent in db.execute(select(Currency.code, Currency.exponent))
    }


def rate_quotes(
    db: Session, lines: Sequence[ExpenseLine], base_currency: str, *, lock: bool = False
) -> list[RateQuote]:
    """Load the rates that could apply to `lines`; `lock` takes a share lock on them."""
    foreign = {line.currency for line in lines if line.currency != base_currency}
    if not foreign:
        return []
    latest = max(line.expense_date for line in lines)
    stmt = select(ExchangeRate).where(
        ExchangeRate.from_currency.in_(foreign), ExchangeRate.effective_date <= latest
    )
    if lock:
        stmt = stmt.with_for_update(read=True)
    return [
        RateQuote(currency=r.from_currency, effective_date=r.effective_date, rate=r.rate)
        for r in db.scalars(stmt)
    ]


def convert_lines(
    db: Session, lines: Sequence[ExpenseLine], base_currency: str, *, lock: bool = False
) -> dict[uuid.UUID, Conversion | None]:
    if not lines:
        return {}
    exponents = currency_exponents(db)
    quotes = rate_quotes(db, lines, base_currency, lock=lock)
    return {
        line.id: convert_line(
            Money(line.amount_minor, line.currency),
            line.expense_date,
            base_currency,
            exponents,
            quotes,
        )
        for line in lines
    }
