import re
from collections.abc import Iterable
from dataclasses import dataclass

_CURRENCY_CODE = re.compile(r"^[A-Z]{3}$")


class CurrencyMismatchError(ValueError):
    pass


@dataclass(frozen=True, slots=True, eq=False)
class Money:
    """An integer amount of minor units in a single currency."""

    amount_minor: int
    currency: str

    def __post_init__(self) -> None:
        if isinstance(self.amount_minor, bool) or not isinstance(self.amount_minor, int):
            raise TypeError("amount_minor must be an int")
        if not _CURRENCY_CODE.match(self.currency):
            raise ValueError(f"invalid currency code: {self.currency!r}")

    @classmethod
    def zero(cls, currency: str) -> "Money":
        return cls(0, currency)

    @classmethod
    def total(cls, amounts: Iterable["Money"], currency: str) -> "Money":
        result = cls.zero(currency)
        for amount in amounts:
            result = result + amount
        return result

    def _require_same_currency(self, other: "Money") -> None:
        if self.currency != other.currency:
            raise CurrencyMismatchError(f"cannot combine {self.currency} with {other.currency}")

    def __add__(self, other: object) -> "Money":
        if not isinstance(other, Money):
            return NotImplemented
        self._require_same_currency(other)
        return Money(self.amount_minor + other.amount_minor, self.currency)

    def __sub__(self, other: object) -> "Money":
        if not isinstance(other, Money):
            return NotImplemented
        self._require_same_currency(other)
        return Money(self.amount_minor - other.amount_minor, self.currency)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Money):
            return NotImplemented
        self._require_same_currency(other)
        return self.amount_minor == other.amount_minor

    def __hash__(self) -> int:
        return hash((self.amount_minor, self.currency))

    def __lt__(self, other: "Money") -> bool:
        self._require_same_currency(other)
        return self.amount_minor < other.amount_minor

    def __le__(self, other: "Money") -> bool:
        self._require_same_currency(other)
        return self.amount_minor <= other.amount_minor

    def __gt__(self, other: "Money") -> bool:
        self._require_same_currency(other)
        return self.amount_minor > other.amount_minor

    def __ge__(self, other: "Money") -> bool:
        self._require_same_currency(other)
        return self.amount_minor >= other.amount_minor
