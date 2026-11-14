from datetime import date
from decimal import Decimal

import pytest

from app.domain.conversion import RateQuote, convert_line, convert_minor, select_rate
from app.domain.money import Money

EXPONENTS = {"USD": 2, "EUR": 2, "JPY": 0, "KWD": 3}


@pytest.mark.parametrize(
    ("amount_minor", "from_exp", "to_exp", "rate", "expected"),
    [
        (1000, 0, 2, "0.0067", 670),  # JPY -> USD
        (1500, 3, 2, "3.25", 488),  # KWD -> USD, 487.5 rounds up to even 488
        (1497, 3, 2, "3.25", 487),  # 486.525 rounds normally
        (1234, 2, 0, "150", 1851),  # USD -> JPY, 1851.0
        (999, 2, 2, "1.1", 1099),  # EUR -> USD, 1098.9
    ],
)
def test_converts_across_exponent_pairs(
    amount_minor: int, from_exp: int, to_exp: int, rate: str, expected: int
) -> None:
    assert convert_minor(amount_minor, from_exp, to_exp, Decimal(rate)) == expected


def test_half_even_tie_with_even_integer_part_rounds_down() -> None:
    assert convert_minor(4865, 3, 2, Decimal("1")) == 486  # 486.5
    assert convert_minor(4875, 3, 2, Decimal("1")) == 488  # 487.5
    assert convert_minor(973, 2, 2, Decimal("0.5")) == 486  # 486.5


def test_half_even_ties_in_both_directions_across_exponents() -> None:
    assert convert_minor(5, 0, 2, Decimal("0.005")) == 2  # 2.5 -> 2
    assert convert_minor(7, 0, 2, Decimal("0.005")) == 4  # 3.5 -> 4


def test_same_exponent_unit_rate_is_identity() -> None:
    assert convert_minor(123_456, 2, 2, Decimal(1)) == 123_456


def test_lines_round_individually_and_total_is_sum_of_rounded_values() -> None:
    third = Decimal("0.3333333333")
    per_line = [convert_minor(100, 2, 2, third) for _ in range(3)]

    assert per_line == [33, 33, 33]
    assert sum(per_line) == 99
    assert convert_minor(300, 2, 2, third) == 100


QUOTES = [
    RateQuote("EUR", date(2026, 1, 1), Decimal("1.08")),
    RateQuote("EUR", date(2026, 2, 1), Decimal("1.09")),
    RateQuote("EUR", date(2026, 4, 1), Decimal("1.20")),
    RateQuote("JPY", date(2026, 1, 15), Decimal("0.0067")),
]


def test_selects_rate_on_exact_date() -> None:
    quote = select_rate(QUOTES, "EUR", date(2026, 2, 1))

    assert quote is not None
    assert quote.rate == Decimal("1.09")


def test_selects_latest_earlier_rate() -> None:
    quote = select_rate(QUOTES, "EUR", date(2026, 3, 20))

    assert quote is not None
    assert quote.effective_date == date(2026, 2, 1)


def test_no_rate_before_earliest_quote() -> None:
    assert select_rate(QUOTES, "EUR", date(2025, 12, 31)) is None
    assert select_rate(QUOTES, "KWD", date(2026, 3, 1)) is None


def test_future_dated_rate_is_ignored() -> None:
    quote = select_rate(QUOTES, "EUR", date(2026, 3, 31))

    assert quote is not None
    assert quote.rate == Decimal("1.09")


def test_base_currency_line_uses_unit_rate_and_expense_date() -> None:
    conversion = convert_line(Money(4200, "USD"), date(2026, 3, 1), "USD", EXPONENTS, QUOTES)

    assert conversion is not None
    assert conversion.rate == Decimal(1)
    assert conversion.effective_date == date(2026, 3, 1)
    assert conversion.base == Money(4200, "USD")


def test_foreign_line_records_quote_used() -> None:
    conversion = convert_line(Money(1000, "JPY"), date(2026, 3, 1), "USD", EXPONENTS, QUOTES)

    assert conversion is not None
    assert conversion.rate == Decimal("0.0067")
    assert conversion.effective_date == date(2026, 1, 15)
    assert conversion.base == Money(670, "USD")


def test_foreign_line_without_rate_is_none() -> None:
    assert convert_line(Money(1000, "JPY"), date(2026, 1, 1), "USD", EXPONENTS, QUOTES) is None
