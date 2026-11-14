"""Stock counters and the movement ledger."""

import uuid
from collections.abc import Iterable
from typing import TYPE_CHECKING

from django.contrib.auth.base_user import AbstractBaseUser
from django.db import transaction

from catalog.models import Product

from .exceptions import AdjustmentBelowReserved
from .models import StockItem, StockMovement

if TYPE_CHECKING:
    from orders.models import Order
    from payments.models import Refund


def create_stock_item(product: Product) -> StockItem:
    return StockItem.objects.create(product=product)


def lock_stock(product_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, StockItem]:
    """Lock and return the stock rows for ``product_ids``. Must run inside a transaction."""
    items = (
        StockItem.objects.select_for_update()
        .filter(product_id__in=set(product_ids))
        .order_by("product_id")
    )
    return {item.product_id: item for item in items}


def apply_movement(
    item: StockItem,
    *,
    kind: str,
    on_hand_delta: int = 0,
    reserved_delta: int = 0,
    order: "Order | None" = None,
    refund: "Refund | None" = None,
    reason: str = "",
    actor: AbstractBaseUser | None = None,
) -> StockMovement:
    """Apply deltas to a locked stock row and append the matching ledger entry."""
    item.on_hand += on_hand_delta
    item.reserved += reserved_delta
    item.save(update_fields=["on_hand", "reserved", "updated_at"])
    return StockMovement.objects.create(
        product_id=item.product_id,
        kind=kind,
        on_hand_delta=on_hand_delta,
        reserved_delta=reserved_delta,
        order=order,
        refund=refund,
        reason=reason,
        actor=actor,
    )


def receive_stock(
    product: Product,
    *,
    quantity: int,
    reason: str,
    actor: AbstractBaseUser | None,
) -> StockItem:
    with transaction.atomic():
        item = lock_stock([product.pk])[product.pk]
        apply_movement(
            item,
            kind=StockMovement.Kind.RECEIVE,
            on_hand_delta=quantity,
            reason=reason,
            actor=actor,
        )
    return item


def adjust_stock(
    product: Product,
    *,
    delta: int,
    reason: str,
    actor: AbstractBaseUser | None,
) -> StockItem:
    with transaction.atomic():
        item = lock_stock([product.pk])[product.pk]
        if item.on_hand + delta < item.reserved:
            raise AdjustmentBelowReserved(
                details={"on_hand": item.on_hand, "reserved": item.reserved, "delta": delta},
            )
        apply_movement(
            item,
            kind=StockMovement.Kind.ADJUST,
            on_hand_delta=delta,
            reason=reason,
            actor=actor,
        )
    return item
