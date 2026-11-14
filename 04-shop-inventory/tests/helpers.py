from django.db.models import Sum

from catalog.models import Product
from inventory.models import StockItem, StockMovement


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
