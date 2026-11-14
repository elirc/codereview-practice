from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_EVEN, Decimal, localcontext

from app.domain.money import Money

CONVERSION_PRECISION = 40
UNIT_RATE = Decimal(1)


@dataclass(frozen=True, slots=True)
class RateQuote:
    """One major unit of `currency` equals `rate` major units of the base currency."""

    currency: str
    effective_date: date
    rate: Decimal


@dataclass(frozen=True, slots=True)
class Conversion:
    rate: Decimal
    effective_date: date
    base: Money


def convert_minor(amount_minor: int, from_exponent: int, to_exponent: int, rate: Decimal) -> int:
    """Convert minor units between currencies, rounding half-even to a whole minor unit."""
    with localcontext() as ctx:
        ctx.prec = CONVERSION_PRECISION
        scaled = Decimal(amount_minor) * rate * Decimal(1).scaleb(to_exponent - from_exponent)
        return int(scaled.quantize(Decimal(1), rounding=ROUND_HALF_EVEN))


def select_rate(quotes: Iterable[RateQuote], currency: str, on: date) -> RateQuote | None:
    """Pick the quote for `currency` with the latest effective date not after `on`."""
    best: RateQuote | None = None
    for quote in quotes:
        if quote.currency != currency or quote.effective_date > on:
            continue
        if best is None or quote.effective_date > best.effective_date:
            best = quote
    return best


def convert_line(
    amount: Money,
    expense_date: date,
    base_currency: str,
    exponents: Mapping[str, int],
    quotes: Iterable[RateQuote],
) -> Conversion | None:
    """Convert one expense line to the base currency, or None when no rate applies."""
    if amount.currency == base_currency:
        return Conversion(rate=UNIT_RATE, effective_date=expense_date, base=amount)

    quote = select_rate(quotes, amount.currency, expense_date)
    if quote is None:
        return None
    base_minor = convert_minor(
        amount.amount_minor, exponents[amount.currency], exponents[base_currency], quote.rate
    )
    return Conversion(
        rate=quote.rate,
        effective_date=quote.effective_date,
        base=Money(base_minor, base_currency),
    )
