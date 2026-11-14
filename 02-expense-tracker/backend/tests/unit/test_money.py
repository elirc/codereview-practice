import dataclasses
from collections.abc import Callable

import pytest

from app.domain.money import CurrencyMismatchError, Money


def test_adds_and_subtracts_same_currency() -> None:
    assert Money(150, "USD") + Money(275, "USD") == Money(425, "USD")
    assert Money(500, "EUR") - Money(125, "EUR") == Money(375, "EUR")


def test_total_of_amounts() -> None:
    amounts = [Money(1, "JPY"), Money(2, "JPY"), Money(3, "JPY")]

    assert Money.total(amounts, "JPY") == Money(6, "JPY")
    assert Money.total([], "JPY") == Money.zero("JPY")


def test_orders_same_currency() -> None:
    assert Money(100, "USD") < Money(101, "USD")
    assert Money(101, "USD") >= Money(101, "USD")


@pytest.mark.parametrize(
    "operation",
    [
        lambda a, b: a + b,
        lambda a, b: a - b,
        lambda a, b: a == b,
        lambda a, b: a < b,
        lambda a, b: a <= b,
        lambda a, b: a > b,
        lambda a, b: a >= b,
    ],
)
def test_mixing_currencies_raises(operation: Callable[[Money, Money], object]) -> None:
    with pytest.raises(CurrencyMismatchError):
        operation(Money(100, "USD"), Money(100, "EUR"))


def test_is_frozen() -> None:
    money = Money(100, "USD")

    with pytest.raises(dataclasses.FrozenInstanceError):
        money.amount_minor = 5  # type: ignore[misc]


@pytest.mark.parametrize("amount", [1.5, "100", True])
def test_rejects_non_integer_amounts(amount: object) -> None:
    with pytest.raises(TypeError):
        Money(amount, "USD")  # type: ignore[arg-type]


def test_rejects_malformed_currency_code() -> None:
    with pytest.raises(ValueError):
        Money(1, "usd")
