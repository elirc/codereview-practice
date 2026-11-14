import threading
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from django.db import connections, transaction
from django.db.models import Sum
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient

from catalog.models import Product
from inventory.models import StockItem, StockMovement
from orders.models import Order
from orders.services import LineRequest, pay_pending_order, place_order, request_payment
from payments.models import WebhookEvent

NOW = datetime(2026, 3, 2, 12, 0, tzinfo=UTC)


def client_for(user) -> APIClient:
    client = APIClient()
    token, _ = Token.objects.get_or_create(user=user)
    client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
    return client


def stock_of(product: Product) -> StockItem:
    return StockItem.objects.get(product=product)


def assert_ledger_balanced(product: Product) -> None:
    item = stock_of(product)
    totals = StockMovement.objects.filter(product=product).aggregate(
        on_hand=Sum("on_hand_delta"),
        reserved=Sum("reserved_delta"),
    )
    assert (totals["on_hand"] or 0) == item.on_hand
    assert (totals["reserved"] or 0) == item.reserved
    assert 0 <= item.reserved <= item.on_hand


def create_order(
    *items: tuple[Product, int],
    now: datetime = NOW,
    email: str = "buyer@example.com",
) -> Order:
    """Place an order through the services and attach its payment intent."""
    lines = [LineRequest(sku=product.sku, quantity=quantity) for product, quantity in items]
    order = place_order(email=email, lines=lines, now=now)
    order, _ = request_payment(order.number, now=now)
    return order


def pay(order: Order, *, now: datetime = NOW) -> Order:
    with transaction.atomic():
        locked = Order.objects.select_for_update().get(pk=order.pk)
        pay_pending_order(locked, amount_paid_minor=locked.total_minor, now=now)
    return locked


def checkout(client, lines: list[dict], key: str = "checkout-key-1", **extra):
    body = {"email": "buyer@example.com", "lines": lines, **extra}
    return client.post("/api/orders/", body, format="json", HTTP_IDEMPOTENCY_KEY=key)


def event_payload(
    event_type: str,
    order: Order,
    *,
    event_id: str | None = None,
    created: datetime = NOW,
    **data,
) -> dict:
    return {
        "id": event_id or f"evt_{uuid.uuid4().hex}",
        "type": event_type,
        "created": int(created.timestamp()),
        "data": {
            "payment_intent_id": order.payment_intent_id,
            "amount_minor": order.total_minor,
            "currency": order.currency,
            **data,
        },
    }


def store_event(event_type: str, order: Order, *, received_at: datetime = NOW, **kwargs):
    """Store an event as the webhook endpoint would, without enqueueing it."""
    payload = event_payload(event_type, order, **kwargs)
    return WebhookEvent.objects.create(
        provider_event_id=payload["id"],
        type=event_type,
        payload=payload,
        provider_created_at=datetime.fromtimestamp(payload["created"], tz=UTC),
        received_at=received_at,
    )


def run_concurrently(*functions: Callable[[], Any], timeout: float = 30) -> list[Any]:
    """Start ``functions`` together on separate threads and connections.

    Returns each function's result, or the exception it raised, in argument order.
    """
    barrier = threading.Barrier(len(functions))
    results: list[Any] = [None] * len(functions)

    def worker(index: int, function: Callable[[], Any]) -> None:
        try:
            barrier.wait(timeout=timeout)
            results[index] = function()
        except BaseException as exc:
            results[index] = exc
        finally:
            connections.close_all()

    threads = [
        threading.Thread(target=worker, args=(index, function))
        for index, function in enumerate(functions)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout)
    assert not any(thread.is_alive() for thread in threads), "a worker thread did not finish"
    return results
