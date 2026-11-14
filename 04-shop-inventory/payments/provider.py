"""Payment provider interface and the in-process fake used in development and tests."""

import functools
import secrets
import threading
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

from django.conf import settings

if TYPE_CHECKING:
    from orders.models import Order


class ProviderError(Exception):
    pass


class ProviderTransientError(ProviderError):
    """The call may succeed if retried with the same idempotency key."""


class ProviderPermanentError(ProviderError):
    """The provider refused the request; retrying will not help."""


@dataclass(frozen=True)
class PaymentIntent:
    id: str
    client_secret: str


@dataclass(frozen=True)
class ProviderRefund:
    id: str


class PaymentProvider(Protocol):
    def create_payment_intent(self, order: "Order") -> PaymentIntent: ...

    def create_refund(
        self,
        payment_intent_id: str,
        amount_minor: int,
        *,
        idempotency_key: str,
    ) -> ProviderRefund: ...


@dataclass
class _Failure:
    error: ProviderError
    after_create: bool = False


@dataclass
class FakeProvider:
    """Records every call and honours idempotency keys the way a real provider does."""

    calls: list[tuple[str, dict]] = field(default_factory=list)
    refunds: dict[str, ProviderRefund] = field(default_factory=dict)
    _intent_failures: list[ProviderError] = field(default_factory=list)
    _refund_failures: list[_Failure] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def fail_next_intent(self, error: ProviderError) -> None:
        with self._lock:
            self._intent_failures.append(error)

    def fail_next_refund(self, error: ProviderError, *, after_create: bool = False) -> None:
        """Make the next ``create_refund`` raise; ``after_create`` simulates a lost response."""
        with self._lock:
            self._refund_failures.append(_Failure(error, after_create))

    def create_payment_intent(self, order: "Order") -> PaymentIntent:
        with self._lock:
            self.calls.append(
                ("create_payment_intent", {"order": order.number, "amount": order.total_minor}),
            )
            if self._intent_failures:
                raise self._intent_failures.pop(0)
            intent_id = f"pi_{secrets.token_hex(12)}"
            secret = f"{intent_id}_secret_{secrets.token_hex(12)}"
            return PaymentIntent(id=intent_id, client_secret=secret)

    def create_refund(
        self,
        payment_intent_id: str,
        amount_minor: int,
        *,
        idempotency_key: str,
    ) -> ProviderRefund:
        with self._lock:
            arguments = {
                "payment_intent_id": payment_intent_id,
                "amount_minor": amount_minor,
                "idempotency_key": idempotency_key,
            }
            self.calls.append(("create_refund", arguments))
            failure = self._refund_failures.pop(0) if self._refund_failures else None
            if failure is not None and not failure.after_create:
                raise failure.error
            refund = self.refunds.get(idempotency_key)
            if refund is None:
                refund = ProviderRefund(id=f"re_{secrets.token_hex(12)}")
                self.refunds[idempotency_key] = refund
            if failure is not None:
                raise failure.error
            return refund


_PROVIDERS = {"fake": FakeProvider}


@functools.cache
def get_provider() -> PaymentProvider:
    """Return the process-wide provider selected by ``PAYMENT_PROVIDER``."""
    return _PROVIDERS[settings.PAYMENT_PROVIDER]()
