from datetime import UTC, datetime

from django.db.models import Sum

from catalog.models import Product
from inventory.models import StockItem, StockMovement
from orders.models import Order
from orders.services import LineRequest, place_order, request_payment

NOW = datetime(2026, 3, 2, 12, 0, tzinfo=UTC)


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


def checkout(client, lines: list[dict], key: str = "checkout-key-1", **extra):
    body = {"email": "buyer@example.com", "lines": lines, **extra}
    return client.post("/api/orders/", body, format="json", HTTP_IDEMPOTENCY_KEY=key)
