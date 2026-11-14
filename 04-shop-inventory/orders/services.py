import hmac
import secrets
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

import structlog
from django.conf import settings
from django.contrib.auth.base_user import AbstractBaseUser
from django.db import connection, transaction

from catalog.models import Product
from core.errors import InvalidState, NotFound
from inventory.models import StockMovement
from inventory.services import apply_movement, lock_stock
from payments.provider import PaymentIntent, ProviderError, get_provider

from .exceptions import InsufficientStock, PaymentProviderUnavailable, UnknownProduct
from .models import Order, OrderLine

logger = structlog.get_logger(__name__)


@dataclass(frozen=True)
class LineRequest:
    sku: str
    quantity: int


def merge_lines(lines: Iterable[LineRequest]) -> list[LineRequest]:
    """Combine lines with the same SKU, keeping the order in which SKUs first appear."""
    quantities: dict[str, int] = {}
    for line in lines:
        quantities[line.sku] = quantities.get(line.sku, 0) + line.quantity
    return [LineRequest(sku=sku, quantity=quantity) for sku, quantity in quantities.items()]


def place_order(*, email: str, lines: Sequence[LineRequest], now: datetime) -> Order:
    """Reserve stock for ``lines`` and create a pending order, all or nothing."""
    with transaction.atomic():
        skus = [line.sku for line in lines]
        products = {
            product.sku: product for product in Product.objects.filter(sku__in=skus, active=True)
        }
        unknown = [sku for sku in skus if sku not in products]
        if unknown:
            raise UnknownProduct(details={"skus": unknown})

        stock = lock_stock(product.pk for product in products.values())
        shortages = [
            {
                "sku": line.sku,
                "requested": line.quantity,
                "available": stock[products[line.sku].pk].available,
            }
            for line in lines
            if stock[products[line.sku].pk].available < line.quantity
        ]
        if shortages:
            raise InsufficientStock(details={"lines": shortages})

        order = Order.objects.create(
            number=_next_order_number(),
            public_token=secrets.token_urlsafe(32),
            email=email,
            status=Order.Status.PENDING_PAYMENT,
            total_minor=sum(products[line.sku].price_minor * line.quantity for line in lines),
            currency=settings.SHOP_CURRENCY,
            reservation_expires_at=now + timedelta(minutes=settings.RESERVATION_MINUTES),
        )
        OrderLine.objects.bulk_create(
            [
                OrderLine(
                    order=order,
                    product=products[line.sku],
                    sku=line.sku,
                    name=products[line.sku].name,
                    unit_price_minor=products[line.sku].price_minor,
                    quantity=line.quantity,
                )
                for line in lines
            ]
        )
        for line in lines:
            apply_movement(
                stock[products[line.sku].pk],
                kind=StockMovement.Kind.RESERVE,
                reserved_delta=line.quantity,
                order=order,
            )
    return order


def request_payment(number: str, *, now: datetime) -> tuple[Order, PaymentIntent]:
    """Create the provider payment intent for a freshly placed order.

    If the provider cannot be reached the order is cancelled and its stock released.
    """
    order = Order.objects.get(number=number)
    try:
        intent = get_provider().create_payment_intent(order)
    except ProviderError as exc:
        logger.warning("payment_intent_failed", order_number=number, error=str(exc))
        release_unpaid_order(order.pk, to_status=Order.Status.CANCELLED, now=now)
        raise PaymentProviderUnavailable() from exc
    Order.objects.filter(pk=order.pk).update(payment_intent_id=intent.id, updated_at=now)
    order.refresh_from_db()
    return order, intent


def release_unpaid_order(
    order_id: uuid.UUID,
    *,
    to_status: str,
    now: datetime,
    only_if_due: bool = False,
    actor: AbstractBaseUser | None = None,
) -> Order | None:
    """Move a pending order to ``to_status`` and release its reservation.

    Returns ``None`` without changing anything when the order is no longer pending, or when
    ``only_if_due`` is set and the reservation has not yet expired.
    """
    with transaction.atomic():
        order = Order.objects.select_for_update().get(pk=order_id)
        if order.status != Order.Status.PENDING_PAYMENT:
            return None
        if only_if_due and order.reservation_expires_at > now:
            return None
        _release_reservation(order, to_status=to_status, actor=actor)
    return order


def _release_reservation(
    order: Order,
    *,
    to_status: str,
    actor: AbstractBaseUser | None = None,
) -> None:
    lines = list(order.lines.all())
    stock = lock_stock(line.product_id for line in lines)
    for line in lines:
        apply_movement(
            stock[line.product_id],
            kind=StockMovement.Kind.RELEASE,
            reserved_delta=-line.quantity,
            order=order,
            actor=actor,
        )
    order.status = to_status
    order.save(update_fields=["status", "updated_at"])


def cancel_order(order_id: uuid.UUID, *, now: datetime, actor: AbstractBaseUser) -> Order:
    order = release_unpaid_order(
        order_id,
        to_status=Order.Status.CANCELLED,
        now=now,
        actor=actor,
    )
    if order is None:
        raise InvalidState("Only orders awaiting payment can be cancelled.")
    return order


def fulfil_order(order_id: uuid.UUID) -> Order:
    with transaction.atomic():
        order = Order.objects.select_for_update().get(pk=order_id)
        if order.status != Order.Status.PAID:
            raise InvalidState("Only paid orders can be fulfilled.")
        order.status = Order.Status.FULFILLED
        order.save(update_fields=["status", "updated_at"])
    return order


def expire_order(order_id: uuid.UUID, *, now: datetime) -> bool:
    expired = release_unpaid_order(
        order_id,
        to_status=Order.Status.EXPIRED,
        now=now,
        only_if_due=True,
    )
    return expired is not None


def expire_due_orders(*, now: datetime, batch_size: int = 200) -> int:
    """Expire up to ``batch_size`` overdue pending orders, each in its own transaction."""
    due = list(
        Order.objects.filter(
            status=Order.Status.PENDING_PAYMENT,
            reservation_expires_at__lte=now,
        )
        .order_by("reservation_expires_at")
        .prefetch_related("lines")[:batch_size]
    )
    expired = 0
    for order in due:
        try:
            with transaction.atomic():
                _release_reservation(order, to_status=Order.Status.EXPIRED)
            expired += 1
        except Exception:
            logger.exception("order_expiry_failed", order_id=str(order.pk))
    return expired


def pay_pending_order(order: Order, *, amount_paid_minor: int, now: datetime) -> None:
    """Mark a pending order paid, consuming its reservation. The caller holds the order lock."""
    lines = list(order.lines.all())
    stock = lock_stock(line.product_id for line in lines)
    for line in lines:
        apply_movement(
            stock[line.product_id],
            kind=StockMovement.Kind.COMMIT,
            on_hand_delta=-line.quantity,
            reserved_delta=-line.quantity,
            order=order,
        )
    _mark_paid(order, amount_paid_minor=amount_paid_minor, now=now)


def pay_released_order(order: Order, *, amount_paid_minor: int, now: datetime) -> bool:
    """Pay an expired or cancelled order by taking its stock again. The caller holds the lock.

    Returns ``False`` and changes nothing when any line can no longer be covered.
    """
    lines = list(order.lines.all())
    stock = lock_stock(line.product_id for line in lines)
    if any(stock[line.product_id].available < line.quantity for line in lines):
        return False
    for line in lines:
        apply_movement(
            stock[line.product_id],
            kind=StockMovement.Kind.COMMIT,
            on_hand_delta=-line.quantity,
            order=order,
        )
    _mark_paid(order, amount_paid_minor=amount_paid_minor, now=now)
    return True


def _mark_paid(order: Order, *, amount_paid_minor: int, now: datetime) -> None:
    order.status = Order.Status.PAID
    order.paid_at = now
    order.amount_paid_minor = amount_paid_minor
    order.save(update_fields=["status", "paid_at", "amount_paid_minor", "updated_at"])


def get_order_for_customer(number: str, token: str) -> Order:
    order = Order.objects.prefetch_related("lines").filter(number=number).first()
    if order is None or not hmac.compare_digest(order.public_token.encode(), token.encode()):
        raise NotFound()
    return order


def _next_order_number() -> str:
    with connection.cursor() as cursor:
        cursor.execute("SELECT nextval('order_number_seq')")
        (value,) = cursor.fetchone()
    return f"SO-{value:06d}"
